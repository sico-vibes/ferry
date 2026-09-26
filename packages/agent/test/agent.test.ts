/* eslint
  @typescript-eslint/no-non-null-assertion: off,
  @typescript-eslint/require-await: off,
  @typescript-eslint/no-empty-function: off,
  @typescript-eslint/unbound-method: off
*/
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ModelInfoSchema,
  ProfileIdSchema,
  ProviderIdSchema,
  ProviderSchema,
  WorkspaceIdSchema,
} from '@ferry/shared';
import { openDatabase, MessageRepository, SessionRepository, TaskRepository } from '@ferry/storage';
import { BUILTIN_PROFILES } from '@ferry/router';
import { createFixtureRepo, FakeOpenAIServer } from '@ferry/testkit';
import { AGENT_EVALS, runAgentEvals } from '../evals/fixtures.js';
import { AgentLoop, repairAndValidate, type AgentEvent } from '../src/loop.js';
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
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(
        /Routing stopped after 4 handoffs.*Ranked candidates:/,
      );
      expect(attempted).toHaveLength(5);
      expect(new Set(attempted).size).toBe(attempted.length);
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

  it('emits and records a rate-limit handoff before continuing on another provider', async () => {
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

      const marker = state.store
        .load(state.session.id)
        ?.messages.flatMap((message) => message.parts)
        .find((part) => part.type === 'handoff_marker');
      expect(marker).toMatchObject({
        type: 'handoff_marker',
        from: state.model.ref,
        to: alternate.ref,
        reason: 'rate_limit',
      });
      if (marker?.type !== 'handoff_marker') throw new Error('Rate-limit marker was not saved');
      expect(marker.briefingTokens).toBeGreaterThanOrEqual(0);
      expect(marker.explanation).toContain('rate_limit (HTTP 429)');
      expect(marker.explanation).toContain('Bearer [redacted]');
      expect(marker.explanation).not.toContain('top-secret-fixture');
      expect(
        events.some(
          (event) => event.type === 'session.part' && event.part.type === 'handoff_marker',
        ),
      ).toBe(true);
      expect(handoffs).toEqual([
        { reason: 'rate_limit', from: state.model.ref, to: alternate.ref },
      ]);
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
          ?.messages.flatMap((message) => message.parts)
          .some((part) => part.type === 'handoff_marker' && part.reason === 'rate_limit'),
      ).toBe(true);
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
      });
      expect((await loop.run({ sessionId: state.session.id })).status).toBe('completed');
      expect(calls).toBe(2);
      expect(
        state.store
          .load(state.session.id)
          ?.messages.flatMap((message) => message.parts)
          .some((part) => part.type === 'handoff_marker' && part.reason === 'error'),
      ).toBe(true);

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
      });
      await expect(failingLoop.run({ sessionId: failedSession.id })).rejects.toThrow(
        /stalled without stream progress/,
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

  it('runs all eight eval scenarios against fixture repos and scripted fake OpenAI responses', async () => {
    expect(AGENT_EVALS).toHaveLength(8);
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
    expect(report).toMatchObject({ mode: 'fake', passed: 8, total: 8 });
    expect(report.results.map(({ id, success }) => [id, success])).toEqual(
      AGENT_EVALS.map(({ id }) => [id, true]),
    );
  }, 30_000);
});
