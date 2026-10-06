/* eslint
  @typescript-eslint/no-non-null-assertion: off,
  @typescript-eslint/require-await: off,
  @typescript-eslint/no-empty-function: off,
  @typescript-eslint/unbound-method: off
*/
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_ROUTING_SETTINGS,
  ModelInfoSchema,
  ProfileIdSchema,
  ProviderIdSchema,
  ProviderSchema,
  WorkspaceIdSchema,
  newTraceId,
  type Message,
  PartIdSchema,
  newId,
} from '@ferry/shared';
import {
  openDatabase,
  MessageRepository,
  SessionRepository,
  TaskRepository,
  TurnLogRepository,
  EventLogRepository,
  ModelSwitchRepository,
  LocalTelemetrySink,
} from '@ferry/storage';
import { BUILTIN_PROFILES } from '@ferry/router';
import { createFixtureRepo, FakeOpenAIServer } from '@ferry/testkit';
import { AGENT_EVALS, runAgentEvals } from '../evals/fixtures.js';
import {
  AgentLoop,
  prepareResumeTranscript,
  repairAndValidate,
  toModelMessages,
  type AgentEvent,
} from '../src/loop.js';
import { SessionStore } from '../src/session.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'ferry-agent-test-'));
  tempDirs.push(root);
  const database = await openDatabase(':memory:');
  const store = new SessionStore({
    sessions: new SessionRepository(database.client),
    messages: new MessageRepository(database.client),
    tasks: new TaskRepository(database.client),
  });
  const model = ModelInfoSchema.parse({
    ref: 'openai/test-model',
    providerId: 'openai',
    name: 'Test Model',
    tier: 'T2',
    contextWindow: 8192,
    maxOutput: 2048,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
  });
  const provider = ProviderSchema.parse({
    id: ProviderIdSchema.parse('openai'),
    name: 'OpenAI',
    tag: 'legit',
    kind: 'api',
    brand: null,
    keyStatus: 'valid',
    enabled: true,
    health: 'ok',
    cooldownUntil: null,
    dataUse: null,
    termsNote: null,
    signupUrl: null,
    docsUrl: null,
    verifiedAt: null,
    modelCount: 1,
    windows: [],
    stepsLeftToday: 20,
  });
  const catalog = { models: [model], providers: [], tiers: {}, warnings: [] };
  const session = store.create({
    workspaceId: WorkspaceIdSchema.parse('workspace_test'),
    profileId: ProfileIdSchema.parse(BUILTIN_PROFILES[0]!.id),
    prompt: 'Please update the greeting in README.md',
  });
  return { root, database, store, session, model, provider, catalog };
}

describe('@ferry/agent', () => {
  it('creates, reloads and lists persisted ordered session messages with a fallback title', async () => {
    const state = await setup();
    try {
      expect(state.session.title).toBe('Please update the greeting in README.md');
      const recovered = new SessionStore({
        sessions: new SessionRepository(state.database.client),
        messages: new MessageRepository(state.database.client),
        tasks: new TaskRepository(state.database.client),
      });
      expect(recovered.load(state.session.id)?.messages.map((message) => message.role)).toEqual([
        'user',
      ]);
      expect(recovered.list(state.session.workspaceId)).toHaveLength(1);
    } finally {
      state.database.close();
    }
  });

  it('repairs valid JSON and reports invalid arguments after revalidation', () => {
    const schema = z.object({ path: z.string() });
    expect(repairAndValidate(schema, '{path: "README.md"}')).toEqual({
      ok: true,
      value: { path: 'README.md' },
    });
    expect(repairAndValidate(schema, '{broken')).toMatchObject({ ok: false });
  });

  it('drops reasoning and handoff speech while preserving complete tool call pairs', async () => {
    const state = await setup();
    try {
      const assistant = state.store.appendMessage(
        state.session.id,
        'assistant',
        [
          {
            type: 'reasoning',
            id: PartIdSchema.parse(newId('part')),
            text: 'private chain of thought',
          },
          { type: 'text', id: PartIdSchema.parse(newId('part')), text: 'Visible answer.' },
          {
            type: 'tool_call',
            id: PartIdSchema.parse(newId('part')),
            toolCallId: 'call-1',
            tool: 'read_file',
            title: 'Read file',
            args: { path: 'README.md' },
            status: 'succeeded',
            output: {
              text: 'file contents',
              filtered: false,
              originalTokens: null,
              filteredTokens: null,
              recoveryHandle: null,
            },
            changes: [],
            durationMs: 1,
          },
          {
            type: 'handoff_marker',
            id: PartIdSchema.parse(newId('part')),
            from: state.model.ref,
            to: state.model.ref,
            reason: 'manual',
            briefingTokens: 0,
            explanation: 'Model handoff: do not serialize this as speech.',
          },
        ],
        state.model.ref,
      );
      const converted = toModelMessages([assistant], state.model);
      expect(JSON.stringify(converted)).not.toContain('private chain of thought');
      expect(JSON.stringify(converted)).not.toContain('Model handoff:');
      expect(JSON.stringify(converted)).toContain('Visible answer.');
      expect(JSON.stringify(converted)).toContain('call-1');
      expect(JSON.stringify(converted)).toContain('file contents');
    } finally {
      state.database.close();
    }
  });

  it('keeps an interrupted text-only assistant message in the resume transcript', () => {
    const message = {
      id: 'message_assistant' as Message['id'],
      sessionId: 'session_test' as Message['sessionId'],
      role: 'assistant' as const,
      createdAt: new Date().toISOString(),
      modelRef: 'openai/test-model' as Message['modelRef'],
      interrupted: { reason: 'rate limit', at: new Date().toISOString() },
      parts: [{ type: 'text' as const, id: PartIdSchema.parse(newId('part')), text: 'Cut off.' }],
    } satisfies Message;
    expect(prepareResumeTranscript([message])).toEqual([message]);
  });

  it('runs a single model step and persists the assistant response', async () => {
    const state = await setup();
    try {
      const events: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: (event) => events.push(event.type),
        generator: async ({ onDelta }) => {
          onDelta('Updated ');
          onDelta('the greeting.');
          return { text: 'Updated the greeting.', inputTokens: 20, outputTokens: 6 };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(result.steps).toBe(1);
      expect(state.store.load(state.session.id)?.messages.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'Updated the greeting.' }),
      );
      expect(events).toContain('session.delta');
    } finally {
      state.database.close();
    }
  });

  it('propagates one trace through attempts and tool I/O, and uses a fresh trace per request', async () => {
    const state = await setup();
    try {
      const turns = new TurnLogRepository(state.database.client);
      const logs = new EventLogRepository(state.database.client);
      const switches = new ModelSwitchRepository(state.database.client);
      const telemetry = new LocalTelemetrySink(turns, logs, switches, true);
      const toolSource = {
        tools: () => [
          {
            name: 'record_note',
            title: 'Record note',
            schema: z.object({ note: z.string() }),
            execute: (args: unknown) => `saved ${(args as { note: string }).note}`,
          },
        ],
      };
      const firstTrace = newTraceId();
      let calls = 0;
      const firstLoop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        maxSteps: 3,
        traceContext: { traceId: firstTrace, sessionId: state.session.id },
        telemetry,
        toolSources: [toolSource],
        generator: async ({ onDelta }) => {
          calls++;
          if (calls === 1)
            return { toolCalls: [{ name: 'record_note', input: { note: 'captured tool input' } }] };
          onDelta('Captured assistant response');
          return {
            text: 'Captured assistant response',
            reasoning: 'Captured reasoning',
            responseModel: 'reported-model-id',
            finishReason: 'stop',
          };
        },
      });
      await firstLoop.run({ sessionId: state.session.id });
      const firstTurns = turns.list();
      expect(firstTurns.length).toBeGreaterThanOrEqual(2);
      expect(firstTurns.every((turn) => turn.trace_id === firstTrace)).toBe(true);
      expect(firstTurns.some((turn) => turn.response_model === 'reported-model-id')).toBe(true);
      expect(firstTurns.some((turn) => typeof turn.ttft_ms === 'number')).toBe(true);
      expect(firstTurns.some((turn) => turn.finish_reason === 'stop')).toBe(true);
      expect(
        logs.list().filter((event) => event.event === 'tool.call' || event.event === 'tool.result'),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ trace_id: firstTrace, event: 'tool.call' }),
          expect.objectContaining({ trace_id: firstTrace, event: 'tool.result' }),
        ]),
      );
      expect(logs.list().find((event) => event.event === 'tool.call')?.data).toMatchObject({
        input: { note: 'captured tool input' },
      });
      expect(logs.list().find((event) => event.event === 'tool.result')?.data).toMatchObject({
        output: 'saved captured tool input',
      });

      const secondTrace = newTraceId();
      const secondLoop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        maxSteps: 1,
        traceContext: { traceId: secondTrace, sessionId: state.session.id },
        telemetry,
        generator: async () => ({ text: 'Second request response', finishReason: 'stop' }),
      });
      await secondLoop.run({ sessionId: state.session.id });
      expect(turns.list().some((turn) => turn.trace_id === secondTrace)).toBe(true);
      expect(secondTrace).not.toBe(firstTrace);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('records fallback attempts with stable group ids and a parent turn', async () => {
    const state = await setup();
    try {
      const turns = new TurnLogRepository(state.database.client);
      const logs = new EventLogRepository(state.database.client);
      const switches = new ModelSwitchRepository(state.database.client);
      const telemetry = new LocalTelemetrySink(turns, logs, switches, false);
      const fallback = ModelInfoSchema.parse({
        ...state.model,
        ref: 'openai/fallback-model',
        name: 'Fallback Model',
      });
      let calls = 0;
      const traceId = newTraceId();
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, fallback] },
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        maxSteps: 1,
        traceContext: { traceId, sessionId: state.session.id },
        telemetry,
        generator: async () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
          return { text: 'Fallback answered.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      const finalMessage = state.store.load(state.session.id)?.messages.at(-1);
      expect(finalMessage?.modelAttempts?.map((attempt) => attempt.model)).toEqual([
        fallback.ref,
        state.model.ref,
      ]);
      expect(finalMessage).toMatchObject({
        modelRef: state.model.ref,
        requestedModelRef: 'auto',
        providerReportedModelId: null,
      });
      expect(finalMessage?.turnId).toBeTruthy();
      expect(finalMessage?.modelAttempts).toMatchObject([
        { model: fallback.ref, outputStarted: false, fallbackReason: 'rate_limit' },
        { model: state.model.ref, outputStarted: true },
      ]);
      expect(state.store.load(state.session.id)?.session.modelRef).toBe(state.model.ref);
      const attempts = turns.list();
      expect(attempts).toHaveLength(2);
      const initialAttempt = attempts.find((attempt) => attempt.attempt === 1);
      const fallbackAttempt = attempts.find((attempt) => attempt.attempt === 2);
      expect(fallbackAttempt).toMatchObject({
        attempt: 2,
        parent_turn_id: initialAttempt?.id,
        request_group_id: initialAttempt?.request_group_id,
      });
      expect(typeof fallbackAttempt?.routed_model).toBe('string');
      expect(initialAttempt).toMatchObject({ status: 'fallback', fallback_reason: 'rate_limit' });
      expect(switches.list()).toContainEqual(
        expect.objectContaining({ kind: 'router_fallback', reason: 'rate_limit' }),
      );
      expect(
        logs.list().some((event) => event.event === 'turn.fallback' && event.trace_id === traceId),
      ).toBe(true);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('completes a weak-model text tool call with a forgiving edit', async () => {
    const state = await setup();
    try {
      await writeFile(path.join(state.root, 'README.md'), "const greeting = 'hello';\n");
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        modelHints: () => ({ toolProtocol: 'xml', editFormat: 'search_replace' }),
        generator: async () => {
          calls++;
          if (calls === 1)
            return {
              text: '```json\n{"name":"edit_file","arguments":{"path":"README.md","edits":[{"search":"const   greeting = \'hello\';","replace":"const greeting = \'hi\';"}]}}\n```',
              finishReason: 'tool-calls',
            };
          return { text: 'Updated the greeting.', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(await readFile(path.join(state.root, 'README.md'), 'utf8')).toBe(
        "const greeting = 'hi';\n",
      );
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('asks approval, checkpoints before a write and resumes with a second step', async () => {
    const state = await setup();
    try {
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'ask',
        emit: () => {},
        requestApproval: async () => 'allowed_once',
        generator: async () =>
          ++calls === 1
            ? {
                toolCalls: [
                  { name: 'write_file', input: { path: 'README.md', content: 'hello\n' } },
                ],
                finishReason: 'tool-calls',
              }
            : { text: 'Done.', finishReason: 'stop' },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(await readFile(path.join(state.root, 'README.md'), 'utf8')).toBe('hello\n');
      const parts =
        state.store.load(state.session.id)?.messages.flatMap((message) => message.parts) ?? [];
      expect(parts.some((part) => part.type === 'approval_request')).toBe(true);
      expect(parts.some((part) => part.type === 'checkpoint')).toBe(true);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('full_auto writes without creating approval parts and ends a max-step run cleanly', async () => {
    const state = await setup();
    try {
      const parts: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        permissionRules: [{ effect: 'ask', tool: '*', level: 'user', pattern: '*' }],
        maxSteps: 1,
        emit: (event) => {
          if (event.type === 'session.part') parts.push(event.part.type);
        },
        generator: async () => ({
          toolCalls: [{ name: 'write_file', input: { path: 'auto.txt', content: 'ok' } }],
          finishReason: 'tool-calls',
        }),
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('limit');
      expect(parts).not.toContain('approval_request');
      expect(await readFile(path.join(state.root, 'auto.txt'), 'utf8')).toBe('ok');
      expect(result.session.status).toBe('idle');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('keeps a manually pinned model pinned when the provider fails', async () => {
    const state = await setup();
    try {
      const fallback = { ...state.model, ref: 'openai/fallback-model' as typeof state.model.ref };
      const attempts: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, fallback] },
        pinnedModelRef: state.model.ref,
        routingSettings: () => ({ ...DEFAULT_ROUTING_SETTINGS, pinnedExhaustion: 'fail' }),
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        generator: async ({ model: selected }) => {
          attempts.push(selected.ref);
          throw Object.assign(new Error('upstream unavailable'), { statusCode: 503 });
        },
        waitForRetry: async () => {},
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(
        /Pinned model openai\/test-model is unavailable and pinnedExhaustion is set to fail/,
      );
      expect(attempts).toEqual([state.model.ref, state.model.ref, state.model.ref]);
      expect(state.store.load(state.session.id)?.session.modelRef).toBeNull();
      const failure = state.store
        .load(state.session.id)
        ?.messages.flatMap((message) => message.parts)
        .find((part) => part.type === 'error');
      if (failure?.type !== 'error') throw new Error('Missing pinned-model failure part');
      expect(failure.message).toContain('pinnedExhaustion is set to fail');
      expect(failure.message).not.toContain('scoreBreakdown');
      expect(failure.details?.attempts).toMatchObject(
        Array.from({ length: 3 }, () => ({ model: state.model.ref, kind: 'server', status: 503 })),
      );
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('retries transient failures with bounded delays and persists the attempt audit', async () => {
    const state = await setup();
    try {
      let calls = 0;
      let fakeNow = 1_000;
      const delays: number[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        maxSteps: 1,
        generator: async () => {
          calls++;
          if (calls < 3)
            throw Object.assign(new Error('temporary upstream outage'), { statusCode: 503 });
          return { text: 'Recovered after retry.', finishReason: 'stop' };
        },
        routingNow: () => fakeNow,
        waitForRetry: async (milliseconds) => {
          delays.push(milliseconds);
          fakeNow += milliseconds;
        },
      });
      await loop.run({ sessionId: state.session.id });
      expect(calls).toBe(3);
      expect(delays).toHaveLength(2);
      expect(delays[0]).toBeGreaterThanOrEqual(150);
      expect(delays[1]).toBeGreaterThanOrEqual(300);
      const finalMessage = state.store.load(state.session.id)?.messages.at(-1);
      expect(finalMessage?.modelAttempts).toMatchObject([
        { status: 503, errorKind: 'server' },
        { status: 503, errorKind: 'server' },
        { status: 200, errorKind: null },
      ]);
      expect(finalMessage?.modelAttempts?.every((attempt) => attempt.provider.length > 0)).toBe(
        true,
      );
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('locks every failed model and caps a failure chain at four handoffs per step', async () => {
    const state = await setup();
    try {
      const candidates = Array.from({ length: 7 }, (_, index) => ({
        ...state.model,
        ref: `openai/test-model-${String(index)}` as typeof state.model.ref,
        name: `Test model ${String(index)}`,
      }));
      const attempted: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: candidates },
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => candidates,
        generator: async ({ model: selected }) => {
          attempted.push(selected.ref);
          throw Object.assign(new Error('upstream service unavailable'), { statusCode: 503 });
        },
        waitForRetry: async () => {},
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(
        /Routing stopped after 4 handoffs.*Ranked candidates:/,
      );
      expect(attempted).toHaveLength(15);
      expect(new Set(attempted).size).toBe(5);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('does not write a denied tool call', async () => {
    const state = await setup();
    try {
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'ask',
        emit: () => {},
        requestApproval: async () => 'denied',
        generator: async ({ onDelta }) => {
          if (
            !state.store
              .load(state.session.id)
              ?.messages.some((message) => message.parts.some((part) => part.type === 'tool_call'))
          )
            return {
              toolCalls: [{ name: 'write_file', input: { path: 'denied.txt', content: 'secret' } }],
              finishReason: 'tool-calls',
            };
          onDelta('The write was denied.');
          return { text: 'The write was denied.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      await expect(readFile(path.join(state.root, 'denied.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        state.store
          .load(state.session.id)
          ?.messages.flatMap((message) => message.parts)
          .some((part) => part.type === 'approval_request' && part.state === 'denied'),
      ).toBe(true);
    } finally {
      state.database.close();
    }
  });

  it('reads a changed model pin at the next step boundary without changing the saved pin', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/next-model',
        providerId: 'gemini',
        name: 'Next Model',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: ProviderIdSchema.parse('gemini'),
        name: 'Gemini',
      });
      state.store.updateSession(state.session.id, { pinnedModelRef: state.model.ref });
      let livePin = state.model.ref;
      const served: string[] = [];
      let generated = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        pinnedModelRef: state.model.ref,
        getPinnedModelRef: () => livePin,
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        generator: async ({ model }) => {
          served.push(model.ref);
          generated++;
          if (generated === 1) {
            livePin = alternate.ref;
            return {
              toolCalls: [{ name: 'record_decision', input: { text: 'Continue', why: 'test' } }],
              finishReason: 'tool-calls',
            };
          }
          return { text: 'Finished.', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(served).toEqual([state.model.ref, alternate.ref]);
      expect(result.session.pinnedModelRef).toBe(state.model.ref);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('compacts context through a summarize step when the token estimate exceeds 70 percent', async () => {
    const state = await setup();
    try {
      const calledModels: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        estimateTokens: (value) => (value.length > 100 ? 7000 : Math.ceil(value.length / 4)),
        generator: async ({ system }) => {
          if (system.startsWith('Summarize')) {
            calledModels.push('summarize');
            return {
              text: 'Keep the requested README edit in mind.',
              inputTokens: 20,
              outputTokens: 8,
            };
          }
          calledModels.push('answer');
          return { text: 'Done.', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(calledModels).toEqual(['summarize', 'answer']);
      expect(
        result.taskRecord.decisions.some(
          (decision) => decision.why === 'Automatic context compaction',
        ),
      ).toBe(true);
    } finally {
      state.database.close();
    }
  });

  it('fits a large handover history to the smaller target and records omitted context', async () => {
    const state = await setup();
    try {
      const small = ModelInfoSchema.parse({
        ...state.model,
        ref: 'openai/small-window',
        name: 'Small Window',
        contextWindow: 8_192,
      });
      for (let index = 0; index < 14; index++) {
        state.store.appendMessage(
          state.session.id,
          'assistant',
          [
            {
              type: 'tool_call',
              id: PartIdSchema.parse(newId('part')),
              toolCallId: `old-${String(index)}`,
              tool: 'read_file',
              title: 'Read file',
              args: { path: `old-${String(index)}.txt` },
              status: 'succeeded',
              output: {
                text: `Old context ${String(index)}. ${'repeated output. '.repeat(450)}`,
                filtered: false,
                originalTokens: null,
                filteredTokens: null,
                recoveryHandle: null,
              },
              changes: [],
              durationMs: 1,
            },
          ],
          state.model.ref,
        );
      }
      const selected: string[] = [];
      let handoffSystem = '';
      let handoffInputEstimate = 0;
      let handoffMessageChars = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, small] },
        resolveCandidates: () => [small, state.model],
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        estimateTokens: (text) => Math.ceil(text.length / 4),
        generator: async ({ model, system, messages }) => {
          selected.push(model.ref);
          handoffSystem = system;
          handoffMessageChars = JSON.stringify(toModelMessages(messages, small)).length;
          handoffInputEstimate = (system.length + handoffMessageChars) / 4;
          return { text: 'Finished.', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(selected).toEqual([small.ref]);
      expect(
        handoffInputEstimate,
        `system=${String(handoffSystem.length)}; messages=${String(handoffMessageChars)}`,
      ).toBeLessThan(small.contextWindow);
      expect(handoffSystem).toContain('[Ferry handover packet]');
      expect(handoffSystem).toContain('Context omitted for your window');
      expect(result.taskRecord.decisions.some((decision) => decision.text.includes('pruned'))).toBe(
        true,
      );
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('hands off to an eligible model after quota capacity removes the current provider', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: ProviderIdSchema.parse('gemini'),
        name: 'Gemini',
      });
      const catalog = { ...state.catalog, models: [state.model, alternate] };
      state.store.updateSession(state.session.id, { modelRef: state.model.ref });
      let providers = [state.provider, alternateProvider];
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog,
        capacity: () => ({ providers }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        generator: async ({ model }) => {
          calls++;
          if (calls === 1) {
            providers = [
              ProviderSchema.parse({ ...state.provider, health: 'down' }),
              alternateProvider,
            ];
            return {
              toolCalls: [{ name: 'read_file', input: { path: 'absent.txt' } }],
              finishReason: 'tool-calls',
            };
          }
          expect(model.ref).toBe(alternate.ref);
          return { text: 'Continued on the alternate model.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      const handoff = state.store
        .load(state.session.id)
        ?.messages.flatMap((message) => message.parts)
        .find((part) => part.type === 'handoff_marker');
      expect(handoff?.type).toBe('handoff_marker');
    } finally {
      state.database.close();
    }
  });

  it('silently retries a pre-output rate limit in one message labelled with the serving model', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: ProviderIdSchema.parse('gemini'),
        name: 'Gemini',
      });
      const catalog = { ...state.catalog, models: [state.model, alternate] };
      state.store.updateSession(state.session.id, { modelRef: state.model.ref });
      const events: AgentEvent[] = [];
      const handoffs: { reason: string; from: string; to: string }[] = [];
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog,
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: (event) => events.push(event),
        resolveCandidates: () => [state.model, alternate],
        onHandoff: (reason, from, to) => handoffs.push({ reason, from, to }),
        generator: async ({ model }) => {
          calls++;
          if (calls === 1)
            throw Object.assign(new Error('scripted rate limit Bearer top-secret-fixture'), {
              statusCode: 429,
            });
          expect(model.ref).toBe(alternate.ref);
          return { text: 'Continued after the rate limit.', finishReason: 'stop' };
        },
      });

      await loop.run({ sessionId: state.session.id });

      const assistantMessages = state.store
        .load(state.session.id)
        ?.messages.filter((message) => message.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages?.[0]).toMatchObject({
        modelRef: alternate.ref,
        parts: [{ type: 'text', text: 'Continued after the rate limit.' }],
        modelAttempts: [
          { model: state.model.ref, status: 429, errorKind: 'rate_limit', outputStarted: false },
          { model: alternate.ref, status: 200 },
        ],
      });
      expect(assistantMessages?.[0]?.parts.some((part) => part.type === 'handoff_marker')).toBe(
        false,
      );
      expect(handoffs).toEqual([]);
      expect(
        events.some(
          (event) => event.type === 'session.part' && event.part.type === 'handoff_marker',
        ),
      ).toBe(false);
    } finally {
      state.database.close();
    }
  });

  it('keeps partial output on A and starts a warned, labelled B handover', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: 'gemini',
        name: 'Gemini',
      });
      const prompts: { model: string; system: string; messages: readonly Message[] }[] = [];
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => [state.model, alternate],
        generator: async ({ model, system, messages, onDelta }) => {
          prompts.push({ model: model.ref, system, messages });
          calls++;
          if (calls === 1) {
            onDelta('I inspected the file and began an unverified claim');
            throw Object.assign(new Error('rate limit'), { statusCode: 429 });
          }
          expect(model.ref).toBe(alternate.ref);
          return { text: 'I will verify the claim first.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });

      const assistants = state.store
        .load(state.session.id)
        ?.messages.filter((message) => message.role === 'assistant');
      expect(assistants).toHaveLength(2);
      const interrupted = assistants?.[0];
      expect(interrupted?.modelRef).toBe(state.model.ref);
      expect(typeof interrupted?.interrupted?.reason).toBe('string');
      expect(typeof interrupted?.interrupted?.at).toBe('string');
      expect(interrupted?.parts).toMatchObject([
        { type: 'text', text: 'I inspected the file and began an unverified claim' },
      ]);
      expect(assistants?.[1]).toMatchObject({ modelRef: alternate.ref });
      expect(assistants?.[1]?.parts[0]?.type).toBe('handoff_marker');
      expect(
        prompts[1]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.parts.some(
              (part) => part.type === 'text' && part.text.includes('unverified claim'),
            ),
        ),
      ).toBe(true);
      expect(prompts[1]?.system).toContain('unfinished and unverified');
      expect(prompts[1]?.system).toContain('Do not repeat it');
    } finally {
      state.database.close();
    }
  });

  it('does not hand over while a prior tool call is still running', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: 'gemini',
        name: 'Gemini',
      });
      state.store.appendMessage(
        state.session.id,
        'assistant',
        [
          {
            type: 'tool_call',
            id: PartIdSchema.parse(newId('part')),
            toolCallId: 'running-1',
            tool: 'bash',
            title: 'Run command',
            args: { command: 'sleep 1' },
            status: 'running',
            output: null,
            changes: [],
            durationMs: null,
          },
        ],
        state.model.ref,
      );
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => [state.model, alternate],
        generator: async ({ onDelta }) => {
          calls++;
          onDelta('partial before blocked handover');
          throw Object.assign(new Error('rate limit'), { statusCode: 429 });
        },
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(/rate limit/i);
      expect(calls).toBe(1);
      const marker = state.store
        .load(state.session.id)
        ?.messages.flatMap((message) => message.parts)
        .find((part) => part.type === 'handoff_marker');
      expect(marker).toBeUndefined();
    } finally {
      state.database.close();
    }
  });

  it('defers handover while an approval request is still pending', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: 'gemini',
        name: 'Gemini',
      });
      state.store.appendMessage(
        state.session.id,
        'assistant',
        [
          {
            type: 'approval_request',
            id: PartIdSchema.parse(newId('part')),
            kind: 'command',
            summary: 'Run rm -rf /tmp/demo',
            detail: 'destructive',
            risk: 'high',
            state: 'pending',
          },
        ],
        state.model.ref,
      );
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => [state.model, alternate],
        generator: async ({ onDelta }) => {
          calls++;
          onDelta('partial before deferred handover');
          throw Object.assign(new Error('rate limit'), { statusCode: 429 });
        },
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(/rate limit/i);
      expect(calls).toBe(1);
      const marker = state.store
        .load(state.session.id)
        ?.messages.flatMap((message) => message.parts)
        .find((part) => part.type === 'handoff_marker');
      expect(marker).toBeUndefined();
    } finally {
      state.database.close();
    }
  });

  it('applies pinned exhaustion fail, ask, and handover policies', async () => {
    for (const policy of ['fail', 'ask', 'handover'] as const) {
      const state = await setup();
      try {
        const alternate = ModelInfoSchema.parse({
          ...state.model,
          ref: 'gemini/test-model',
          providerId: 'gemini',
          name: 'Gemini',
        });
        const alternateProvider = ProviderSchema.parse({
          ...state.provider,
          id: 'gemini',
          name: 'Gemini',
        });
        let calls = 0;
        const approvals: string[] = [];
        const loop = new AgentLoop({
          store: state.store,
          workspace: state.root,
          dataDir: state.root,
          profile: BUILTIN_PROFILES[0]!,
          catalog: { ...state.catalog, models: [state.model, alternate] },
          capacity: () => ({ providers: [state.provider, alternateProvider] }),
          apiKeys: {},
          permissionMode: 'full_auto',
          emit: () => {},
          pinnedModelRef: state.model.ref,
          routingSettings: () => ({ ...DEFAULT_ROUTING_SETTINGS, pinnedExhaustion: policy }),
          resolveCandidates: () => [state.model, alternate],
          requestApproval: async (part) => {
            approvals.push(part.kind);
            return 'allowed_once';
          },
          generator: async ({ model }) => {
            calls++;
            if (calls === 1) throw Object.assign(new Error('usage limit'), { statusCode: 429 });
            expect(model.ref).toBe(alternate.ref);
            return { text: 'Continued.', finishReason: 'stop' };
          },
        });

        if (policy === 'fail') {
          await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(
            /pinnedExhaustion is set to fail/,
          );
          expect(calls).toBe(1);
        } else {
          await loop.run({ sessionId: state.session.id });
          expect(calls).toBe(2);
          const assistants = state.store
            .load(state.session.id)
            ?.messages.filter((message) => message.role === 'assistant');
          expect(assistants).toHaveLength(2);
          expect(assistants?.[1]?.modelRef).toBe(alternate.ref);
          expect(assistants?.[1]?.parts.some((part) => part.type === 'handoff_marker')).toBe(true);
          expect(approvals).toEqual(policy === 'ask' ? ['model_handover'] : []);
        }
      } finally {
        state.database.close();
      }
    }
  });

  it('does not exclude a provider when one key fails and another key remains', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'openai/alternate-model',
        name: 'Alternate OpenAI model',
      });
      const calls: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        providerAffinityKey: () => 'openai:key-1',
        providerKeyIds: () => ['openai:key-1', 'openai:key-2'],
        resolveCandidates: () => [state.model, alternate],
        generator: async ({ model }) => {
          calls.push(model.ref);
          if (calls.length === 1)
            throw Object.assign(new Error('invalid api key'), { statusCode: 401 });
          return { text: 'Recovered on the same provider.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      expect(calls).toEqual([state.model.ref, alternate.ref]);
    } finally {
      state.database.close();
    }
  });

  it('adds a handover packet when the routed model changes between completed steps', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: 'gemini',
        name: 'Gemini',
      });
      let candidates = [state.model];
      let calls = 0;
      let secondSystem = '';
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => candidates,
        generator: async ({ model, system }) => {
          calls++;
          if (calls === 1) {
            expect(model.ref).toBe(state.model.ref);
            candidates = [alternate];
            return {
              toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }],
              finishReason: 'tool-calls',
            };
          }
          secondSystem = system;
          expect(model.ref).toBe(alternate.ref);
          return { text: 'Finished the next step.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      const assistants = state.store
        .load(state.session.id)
        ?.messages.filter((message) => message.role === 'assistant');
      expect(assistants?.[0]?.parts.some((part) => part.type === 'handoff_marker')).toBe(true);
      expect(secondSystem).toContain('completed its step');
      expect(secondSystem).toContain('Plan');
      expect(secondSystem).toContain('Files touched');
      expect(calls).toBe(2);
    } finally {
      state.database.close();
    }
  });

  it('bypasses a soft quota candidate at the next step boundary and keeps it bypassed', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: 'gemini',
        name: 'Gemini',
      });
      const windows = [
        {
          id: 'openai-daily-tokens',
          scope: 'provider' as const,
          modelRef: null,
          metric: 'tokens' as const,
          kind: 'fixed_daily' as const,
          periodLabel: 'daily',
          used: 7_500,
          limit: 10_000,
          remaining: 2_500,
          resetAt: '2026-06-02T00:00:00.000Z',
          confidence: 'exact' as const,
          observedAt: new Date().toISOString(),
          durationMs: 24 * 60 * 60_000,
        },
      ];
      let quotaIsLow = false;
      const used: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        capacity: () => ({
          providers: [
            {
              ...state.provider,
              windows: quotaIsLow ? windows : [],
              // Soft via stepsLeft < 2 with remaining still above one-step hard exhaustion.
              stepsLeftToday: quotaIsLow ? 1 : 5,
            },
            alternateProvider,
          ],
        }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => [state.model, alternate],
        generator: async ({ model }) => {
          used.push(model.ref);
          if (used.length === 1) {
            quotaIsLow = true;
            return {
              toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }],
              finishReason: 'tool-calls',
            };
          }
          if (used.length === 2)
            return {
              toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }],
              finishReason: 'tool-calls',
            };
          return { text: 'Done.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      expect(used).toEqual([state.model.ref, alternate.ref, alternate.ref]);
    } finally {
      state.database.close();
    }
  });

  it('excludes a candidate with fresh hard quota exhaustion before dispatch', async () => {
    const state = await setup();
    try {
      const alternate = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/test-model',
        providerId: 'gemini',
        name: 'Gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: 'gemini',
        name: 'Gemini',
      });
      const now = new Date().toISOString();
      const exhaustedWindow = {
        id: 'openai-daily-tokens',
        scope: 'provider' as const,
        modelRef: null,
        metric: 'tokens' as const,
        kind: 'fixed_daily' as const,
        periodLabel: 'daily',
        used: 10_000,
        limit: 10_000,
        remaining: 0,
        resetAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        confidence: 'exact' as const,
        observedAt: now,
        durationMs: 24 * 60 * 60_000,
      };
      const used: string[] = [];
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, alternate] },
        capacity: () => ({
          providers: [{ ...state.provider, windows: [exhaustedWindow] }, alternateProvider],
        }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => [state.model, alternate],
        generator: async ({ model }) => {
          used.push(model.ref);
          return { text: 'Done.', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      expect(used).toEqual([alternate.ref]);
    } finally {
      state.database.close();
    }
  });

  it('reroutes an HTTP ResourceExhausted response from the fake OpenAI server', async () => {
    const state = await setup();
    const success = {
      id: 'chatcmpl_fallback',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Recovered on fallback.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    };
    const fake = await new FakeOpenAIServer({
      responses: [
        {
          status: 429,
          body: {
            error: {
              code: 'RESOURCE_EXHAUSTED',
              message: 'Worker local total request limit reached (16/16)',
            },
          },
        },
        { body: success },
      ],
    }).start();
    try {
      const fallback = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/fallback-model',
        providerId: 'gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: ProviderIdSchema.parse('gemini'),
        name: 'Gemini',
      });
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, fallback] },
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: { openai: 'fixture-key', gemini: 'fixture-key' },
        providerBaseUrls: {
          openai: `${fake.baseUrl}/v1`,
          gemini: `${fake.baseUrl}/v1`,
        },
        permissionMode: 'full_auto',
        emit: () => {},
        resolveCandidates: () => [state.model, fallback],
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(
        fake.requests
          .filter(({ method, url }) => method === 'POST' && url.endsWith('/chat/completions'))
          .map(({ body }) => (body as { model: string }).model),
      ).toEqual(['test-model', 'fallback-model']);
      expect(
        state.store
          .load(state.session.id)
          ?.messages.filter((message) => message.role === 'assistant'),
      ).toHaveLength(1);
    } finally {
      await fake.stop();
      state.database.close();
    }
  }, 30_000);

  it('reroutes a step that stalls without stream progress and errors if no candidate remains', async () => {
    const state = await setup();
    try {
      const fallback = ModelInfoSchema.parse({
        ...state.model,
        ref: 'gemini/fallback-model',
        providerId: 'gemini',
      });
      const alternateProvider = ProviderSchema.parse({
        ...state.provider,
        id: ProviderIdSchema.parse('gemini'),
        name: 'Gemini',
      });
      let calls = 0;
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: { ...state.catalog, models: [state.model, fallback] },
        capacity: () => ({ providers: [state.provider, alternateProvider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        stepTimeoutMs: 10,
        resolveCandidates: () => [state.model, fallback],
        generator: async ({ signal, model: selected }) => {
          calls++;
          if (calls === 1)
            return await new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  reject(
                    signal.reason instanceof Error
                      ? signal.reason
                      : new Error('Step watchdog aborted the stalled model'),
                  );
                },
                { once: true },
              );
            });
          expect(selected.ref).toBe(fallback.ref);
          return { text: 'Completed after the stalled model.', finishReason: 'stop' };
        },
        waitForRetry: async () => {},
      });
      expect((await loop.run({ sessionId: state.session.id })).status).toBe('completed');
      expect(calls).toBe(4);
      expect(
        state.store
          .load(state.session.id)
          ?.messages.filter((message) => message.role === 'assistant'),
      ).toHaveLength(1);

      const failedSession = state.store.create({
        workspaceId: state.session.workspaceId,
        profileId: state.session.profileId,
        prompt: 'This must fail promptly',
      });
      const failingLoop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        stepTimeoutMs: 10,
        generator: async () => await new Promise(() => undefined),
        waitForRetry: async () => {},
      });
      await expect(failingLoop.run({ sessionId: failedSession.id })).rejects.toThrow(
        /All free candidates exhausted for plan/,
      );
      expect(state.store.load(failedSession.id)?.session.status).toBe('error');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('cancels a pending generation and leaves the session resumable', async () => {
    const state = await setup();
    try {
      const controller = new AbortController();
      const loop = new AgentLoop({
        store: state.store,
        workspace: state.root,
        dataDir: state.root,
        profile: BUILTIN_PROFILES[0]!,
        catalog: state.catalog,
        capacity: () => ({ providers: [state.provider] }),
        apiKeys: {},
        permissionMode: 'full_auto',
        emit: () => {},
        generator: async ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      });
      const running = loop.run({ sessionId: state.session.id, signal: controller.signal });
      controller.abort();
      expect((await running).status).toBe('cancelled');
      expect(state.store.load(state.session.id)).toBeDefined();
    } finally {
      state.database.close();
    }
  });

  it('runs all configured eval scenarios against fixture repos and scripted fake OpenAI responses', async () => {
    const report = await runAgentEvals({
      run: async (fixture) => {
        const repo = await createFixtureRepo(fixture.template);
        const state = await setup();
        const response = `Evaluated ${fixture.id}`;
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
          id: 'chatcmpl_eval',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        const fake = await FakeOpenAIServer.scriptedTurns([
          {
            chunks: [chunk({ role: 'assistant' }), chunk({ content: response }), chunk({}, 'stop')],
          },
        ]).start();
        try {
          const loop = new AgentLoop({
            store: state.store,
            workspace: repo.path,
            dataDir: state.root,
            profile: BUILTIN_PROFILES[0]!,
            catalog: state.catalog,
            capacity: () => ({ providers: [state.provider] }),
            apiKeys: { openai: 'fixture-key' },
            permissionMode: 'full_auto',
            emit: () => {},
            providerFetch: (input, init) => {
              const request = input instanceof Request ? input : new Request(input, init);
              const url = new URL(request.url);
              return fetch(new URL(`${url.pathname}${url.search}`, fake.baseUrl), request);
            },
          });
          const result = await loop.run({ sessionId: state.session.id });
          return {
            success:
              result.status === 'completed' &&
              fake.requests.length === 1 &&
              state.store
                .load(state.session.id)
                ?.messages.at(-1)
                ?.parts.some((part) => part.type === 'text' && part.text === response) === true,
            steps: result.steps,
            tokens: result.tokens,
          };
        } finally {
          await fake.stop();
          state.database.close();
          await repo.cleanup();
        }
      },
    });
    expect(report).toMatchObject({
      mode: 'fake',
      passed: AGENT_EVALS.length,
      total: AGENT_EVALS.length,
    });
    expect(report.results.map(({ id, success }) => [id, success])).toEqual(
      AGENT_EVALS.map(({ id }) => [id, true]),
    );
  }, 30_000);
});
