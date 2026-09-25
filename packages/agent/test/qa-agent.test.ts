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
  ModelInfoSchema,
  ProfileIdSchema,
  ProviderIdSchema,
  ProviderSchema,
  WorkspaceIdSchema,
} from '@ferry/shared';
import { openDatabase, MessageRepository, SessionRepository, TaskRepository } from '@ferry/storage';
import { BUILTIN_PROFILES } from '@ferry/router';
import { evaluatePermission } from '@ferry/workspace';
import { FakeOpenAIServer } from '@ferry/testkit';
import { AGENT_EVALS, runAgentEvals } from '../evals/fixtures.js';
import { AgentLoop, repairAndValidate, type AgentOptions } from '../src/loop.js';
import { SessionStore } from '../src/session.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'ferry-qa-agent-'));
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

type State = Awaited<ReturnType<typeof setup>>;

function makeLoop(state: State, overrides: Partial<AgentOptions> = {}): AgentLoop {
  return new AgentLoop({
    store: state.store,
    workspace: state.root,
    dataDir: state.root,
    profile: BUILTIN_PROFILES[0]!,
    catalog: state.catalog,
    capacity: () => ({ providers: [state.provider] }),
    apiKeys: {},
    emit: () => {},
    ...overrides,
    permissionMode: overrides.permissionMode ?? 'full_auto',
  });
}

function partsOf(state: State) {
  return state.store.load(state.session.id)?.messages.flatMap((message) => message.parts) ?? [];
}

function textParts(state: State) {
  return partsOf(state)
    .filter((part) => part.type === 'text')
    .map((part) => part.text);
}

describe('QA agent: cancellation phases', () => {
  it('cancels while streaming, leaves the session idle, and never runs a queued write', async () => {
    const state = await setup();
    try {
      const controller = new AbortController();
      let generatorStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        generatorStarted = resolve;
      });
      const loop = makeLoop(state, {
        generator: async ({ signal }) => {
          generatorStarted();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('cancelled'));
              },
              { once: true },
            );
          });
        },
      });
      const running = loop.run({ sessionId: state.session.id, signal: controller.signal });
      await started;
      controller.abort();
      const result = await running;
      expect(result.status).toBe('cancelled');
      expect(state.store.load(state.session.id)?.session.status).toBe('idle');
      await expect(readFile(path.join(state.root, 'queued.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('cancels mid tool execution without leaking a partially applied file write', async () => {
    const state = await setup();
    try {
      await writeFile(path.join(state.root, 'target.txt'), 'original\n', 'utf8');
      const controller = new AbortController();
      let approvalStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        approvalStarted = resolve;
      });
      const loop = makeLoop(state, {
        permissionMode: 'ask',
        requestApproval: async (_part, signal) => {
          approvalStarted();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('cancelled'));
              },
              { once: true },
            );
          });
        },
        generator: async () => ({
          toolCalls: [
            { name: 'write_file', input: { path: 'target.txt', content: 'overwritten\n' } },
          ],
          finishReason: 'tool-calls',
        }),
      });
      const running = loop.run({ sessionId: state.session.id, signal: controller.signal });
      await started;
      controller.abort();
      const result = await running;
      expect(result.status).toBe('cancelled');
      expect(await readFile(path.join(state.root, 'target.txt'), 'utf8')).toBe('original\n');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it.fails(
    'resolves a pending approval when cancelled during the approval wait',
    async () => {
      // BUG: when the run is cancelled while requestApproval() is awaiting, the
      // loop aborts the tool race, leaves the approval_request part at
      // state:"pending" forever, and then appends the "retry once" user message
      // after the cancellation (loop.ts:239-242, 423-501).
      const state = await setup();
      try {
        const controller = new AbortController();
        let approvalStarted: () => void = () => {};
        const started = new Promise<void>((resolve) => {
          approvalStarted = resolve;
        });
        const loop = makeLoop(state, {
          permissionMode: 'ask',
          requestApproval: async (_part, signal) => {
            approvalStarted();
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  reject(new Error('cancelled'));
                },
                {
                  once: true,
                },
              );
            });
          },
          generator: async () => ({
            toolCalls: [{ name: 'write_file', input: { path: 'never.txt', content: 'x' } }],
            finishReason: 'tool-calls',
          }),
        });
        const running = loop.run({ sessionId: state.session.id, signal: controller.signal });
        await started;
        controller.abort();
        await running;
        const approval = partsOf(state).find((part) => part.type === 'approval_request');
        expect(approval?.state).not.toBe('pending');
        const userText = (
          state.store.load(state.session.id)?.messages.filter((m) => m.role === 'user') ?? []
        ).flatMap((message) =>
          message.parts.filter((part) => part.type === 'text').map((part) => part.text),
        );
        expect(userText.some((text) => text.includes('retry once'))).toBe(false);
      } finally {
        state.database.close();
      }
    },
    30_000,
  );
});

describe('QA agent: permissions', () => {
  it('never executes an ask-mode tool before approval resolves', async () => {
    const state = await setup();
    try {
      let release: (value: 'allowed_once') => void = () => {};
      const gate = new Promise<'allowed_once'>((resolve) => {
        release = resolve;
      });
      let approvalStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        approvalStarted = resolve;
      });
      let calls = 0;
      const loop = makeLoop(state, {
        permissionMode: 'ask',
        requestApproval: async () => {
          approvalStarted();
          return gate;
        },
        generator: async () => {
          calls++;
          return calls === 1
            ? {
                toolCalls: [{ name: 'write_file', input: { path: 'gated.txt', content: 'ok' } }],
                finishReason: 'tool-calls',
              }
            : { text: 'done', finishReason: 'stop' };
        },
      });
      const running = loop.run({ sessionId: state.session.id });
      await started;
      await expect(readFile(path.join(state.root, 'gated.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      release('allowed_once');
      const result = await running;
      expect(result.status).toBe('completed');
      expect(await readFile(path.join(state.root, 'gated.txt'), 'utf8')).toBe('ok');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('shows the model a structured denial without writing the file', async () => {
    const state = await setup();
    try {
      const loop = makeLoop(state, {
        permissionMode: 'ask',
        requestApproval: async () => 'denied',
        generator: async () =>
          partsOf(state).some((part) => part.type === 'tool_call')
            ? { text: 'Understood, I will not write that.', finishReason: 'stop' }
            : {
                toolCalls: [{ name: 'write_file', input: { path: 'denied.txt', content: 'x' } }],
                finishReason: 'tool-calls',
              },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      await expect(readFile(path.join(state.root, 'denied.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const approval = partsOf(state).find((part) => part.type === 'approval_request');
      expect(approval?.state).toBe('denied');
      const denial = textParts(state).find((text) => text.includes('denied'));
      expect(denial).toContain('write_file');
      expect(
        partsOf(state).find((part) => part.type === 'tool_call' && part.status === 'failed')?.type,
      ).toBe('tool_call');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('auto_edit still gates commands and full_auto still denies dangerous commands', () => {
    const workspace = 'C:\\work';
    expect(
      evaluatePermission(
        { tool: 'run_command', command: 'echo hello' },
        { mode: 'auto_edit', workspace, rules: [] },
      ).decision,
    ).toBe('ask');
    expect(
      evaluatePermission(
        { tool: 'write_file', path: 'a.ts' },
        { mode: 'auto_edit', workspace, rules: [] },
      ).decision,
    ).toBe('allow');
    expect(
      evaluatePermission(
        { tool: 'run_command', command: 'rm -rf /' },
        { mode: 'auto_edit', workspace, rules: [] },
      ).decision,
    ).toBe('deny');
    expect(
      evaluatePermission(
        { tool: 'run_command', command: 'rm -rf /' },
        { mode: 'full_auto', workspace, rules: [] },
      ).decision,
    ).toBe('deny');
  });
});

describe('QA agent: hostile model output and tool-call validation', () => {
  it('repairs near-JSON tool arguments and dispatches the call', async () => {
    const state = await setup();
    try {
      await writeFile(path.join(state.root, 'notes.txt'), 'hello world', 'utf8');
      const loop = makeLoop(state, {
        generator: async () =>
          partsOf(state).some((part) => part.type === 'tool_call')
            ? { text: 'read it', finishReason: 'stop' }
            : {
                toolCalls: [{ name: 'read_file', input: '{path: "notes.txt"}' }],
                finishReason: 'tool-calls',
              },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      const call = partsOf(state).find((part) => part.type === 'tool_call');
      expect(call?.type === 'tool_call' ? call.status : undefined).toBe('succeeded');
      expect(call?.type === 'tool_call' ? call.output?.text : '').toContain('hello world');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('surfaces unknown tool names back to the model instead of crashing', async () => {
    const state = await setup();
    try {
      let calls = 0;
      const loop = makeLoop(state, {
        generator: async () => {
          calls++;
          return calls === 1
            ? {
                toolCalls: [{ name: 'launch_missiles', input: { target: 'earth' } }],
                finishReason: 'tool-calls',
              }
            : { text: 'sorry', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(textParts(state).some((text) => text.includes('Unknown tool: launch_missiles'))).toBe(
        true,
      );
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('rejects path traversal in tool arguments through the workspace jail', async () => {
    const state = await setup();
    try {
      const loop = makeLoop(state, {
        generator: async () =>
          partsOf(state).some((part) => part.type === 'tool_call')
            ? { text: 'blocked', finishReason: 'stop' }
            : {
                toolCalls: [{ name: 'read_file', input: { path: '../../etc/passwd' } }],
                finishReason: 'tool-calls',
              },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      const call = partsOf(state).find((part) => part.type === 'tool_call');
      expect(call?.type === 'tool_call' ? call.status : undefined).toBe('failed');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('handles very large arguments without throwing', async () => {
    const state = await setup();
    try {
      const big = Array.from(
        { length: 4_000 },
        (_, index) => `line-${String(index)}-${'abcdefghij'.repeat(3)}`,
      ).join('\n');
      let calls = 0;
      const loop = makeLoop(state, {
        generator: async () => {
          calls++;
          return calls === 1
            ? {
                toolCalls: [{ name: 'write_file', input: { path: 'big.txt', content: big } }],
                finishReason: 'tool-calls',
              }
            : { text: 'written', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect((await readFile(path.join(state.root, 'big.txt'), 'utf8')).length).toBe(big.length);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('bounds an endlessly repeated identical tool call by the step budget', async () => {
    const state = await setup();
    try {
      await writeFile(path.join(state.root, 'loop.txt'), 'data', 'utf8');
      const loop = makeLoop(state, {
        maxSteps: 3,
        generator: async () => ({
          toolCalls: [{ name: 'read_file', input: { path: 'loop.txt' } }],
          finishReason: 'tool-calls',
        }),
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('limit');
      expect(partsOf(state).filter((part) => part.type === 'tool_call').length).toBeLessThan(10);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('completes empty and reasoning-only responses without dispatching tools', async () => {
    const state = await setup();
    try {
      const empty = makeLoop(state, {
        generator: async () => ({ finishReason: 'stop' }),
      });
      expect((await empty.run({ sessionId: state.session.id })).status).toBe('completed');

      const reasoning = makeLoop(state, {
        generator: async () => ({ reasoning: 'thinking only', finishReason: 'stop' }),
      });
      expect((await reasoning.run({ sessionId: state.session.id })).status).toBe('completed');
      expect(
        partsOf(state).some((part) => part.type === 'reasoning' && part.text === 'thinking only'),
      ).toBe(true);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('repairs or rejects broken JSON in repairAndValidate without side effects', () => {
    const schema = z.object({ path: z.string() });
    expect(repairAndValidate(schema, '{path: "a.ts"}')).toEqual({
      ok: true,
      value: { path: 'a.ts' },
    });
    for (const hostile of [
      null,
      42,
      '[1,2,3]',
      '{"path": 7}',
      '{"__proto__": {"polluted": true}, "path": "a.ts"}',
      'x'.repeat(100_000),
    ]) {
      const result = repairAndValidate(schema, hostile);
      if (result.ok) expect(typeof result.value.path).toBe('string');
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('QA agent: budgets and compaction', () => {
  it('stops the run once the token budget is exhausted', async () => {
    const state = await setup();
    try {
      await writeFile(path.join(state.root, 'b.txt'), 'data', 'utf8');
      const loop = makeLoop(state, {
        tokenBudget: 250,
        maxSteps: 100,
        generator: async () => ({
          toolCalls: [{ name: 'read_file', input: { path: 'b.txt' } }],
          inputTokens: 100,
          outputTokens: 0,
          finishReason: 'tool-calls',
        }),
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('limit');
      expect(result.tokens).toBeGreaterThanOrEqual(250);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it.fails(
    'never exceeds maxSteps',
    async () => {
      // BUG: the tool-dispatch loop increments stepCount for each executed tool
      // call in addition to the model step (loop.ts:376, 486), so with
      // maxSteps=1 the run still reports and performs 2 steps.
      const state = await setup();
      try {
        await writeFile(path.join(state.root, 's.txt'), 'data', 'utf8');
        const loop = makeLoop(state, {
          maxSteps: 1,
          generator: async () => ({
            toolCalls: [{ name: 'read_file', input: { path: 's.txt' } }],
            finishReason: 'tool-calls',
          }),
        });
        const result = await loop.run({ sessionId: state.session.id });
        expect(result.steps).toBeLessThanOrEqual(1);
      } finally {
        state.database.close();
      }
    },
    30_000,
  );

  it('compacts at the threshold and preserves the goal and summary for the next step', async () => {
    const state = await setup();
    try {
      const systems: string[] = [];
      const loop = makeLoop(state, {
        estimateTokens: (value) => (value.length > 100 ? 7000 : Math.ceil(value.length / 4)),
        generator: async ({ system, onDelta }) => {
          systems.push(system);
          if (system.startsWith('Summarize'))
            return { text: 'Pinned: keep goal and plan.', inputTokens: 10, outputTokens: 5 };
          onDelta('Done.');
          return { text: 'Done.', inputTokens: 10, outputTokens: 2, finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(result.taskRecord.goal).toBe('Please update the greeting in README.md');
      expect(
        result.taskRecord.decisions.some(
          (decision) => decision.why === 'Automatic context compaction',
        ),
      ).toBe(true);
      expect(systems.some((system) => system.includes('Pinned: keep goal and plan.'))).toBe(true);
    } finally {
      state.database.close();
    }
  }, 30_000);
});

describe('QA agent: optimizer recovery wiring', () => {
  it('attaches a recovery handle to shortened tool output', async () => {
    const state = await setup();
    try {
      const file = `secret line\n${Array.from({ length: 500 }, (_, i) => `line ${String(i)}`).join('\n')}`;
      await writeFile(path.join(state.root, 'huge.txt'), file, 'utf8');
      const loop = makeLoop(state, {
        generator: async () =>
          partsOf(state).some((part) => part.type === 'tool_call')
            ? { text: 'done', finishReason: 'stop' }
            : {
                toolCalls: [{ name: 'read_file', input: { path: 'huge.txt' } }],
                finishReason: 'tool-calls',
              },
      });
      await loop.run({ sessionId: state.session.id });
      const call = partsOf(state).find((part) => part.type === 'tool_call');
      expect(call?.type === 'tool_call' ? call.output?.filtered : false).toBe(true);
      expect(call?.type === 'tool_call' ? call.output?.recoveryHandle : null).toBeTruthy();
    } finally {
      state.database.close();
    }
  }, 30_000);

  it.fails(
    'read_output returns the byte-exact original through the loop',
    async () => {
      // BUG (two layers): (1) ToolNameSchema (shared/domain/session.ts:37) omits
      // "read_output", so persisting the tool_call part rejects the run; and
      // (2) loop.ts:438 stores the *filtered* text under the recovery handle in
      // outputHandles, which readRecovery() checks before the byte-exact blob
      // store (loop.ts:193).
      const state = await setup();
      try {
        await writeFile(path.join(state.root, 'orig.txt'), 'ORIGINAL-CONTENT', 'utf8');
        const originals = new Map<string, string>();
        let returned: string | undefined;
        let calls = 0;
        const loop = makeLoop(state, {
          filterOutput: async (name, text) => {
            if (name === 'read_file') {
              originals.set('H', text);
              return { text: 'FILTERED', filtered: true, recoveryHandle: 'H' };
            }
            if (name === 'read_output') returned = text;
            return { text, filtered: false };
          },
          readRecovery: async (handle) => originals.get(handle),
          generator: async () => {
            calls++;
            if (calls === 1)
              return {
                toolCalls: [{ name: 'read_file', input: { path: 'orig.txt' } }],
                finishReason: 'tool-calls',
              };
            if (calls === 2)
              return {
                toolCalls: [{ name: 'read_output', input: { handle: 'H' } }],
                finishReason: 'tool-calls',
              };
            return { text: 'done', finishReason: 'stop' };
          },
        });
        const result = await loop.run({ sessionId: state.session.id });
        expect(result.status).toBe('completed');
        expect(returned).toBe('ORIGINAL-CONTENT');
      } finally {
        state.database.close();
      }
    },
    30_000,
  );

  it.fails(
    'apply_patch is accepted as a persisted tool name',
    async () => {
      // BUG: ToolNameSchema omits "apply_patch" even though tool-registry.ts:154
      // registers and advertises it, so any apply_patch call crashes the session.
      const state = await setup();
      try {
        await writeFile(path.join(state.root, 'p.txt'), 'one\ntwo\nthree\n', 'utf8');
        const loop = makeLoop(state, {
          generator: async () =>
            partsOf(state).some((part) => part.type === 'tool_call')
              ? { text: 'patched', finishReason: 'stop' }
              : {
                  toolCalls: [
                    {
                      name: 'apply_patch',
                      input: {
                        patch:
                          '--- a/p.txt\n+++ b/p.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three',
                      },
                    },
                  ],
                  finishReason: 'tool-calls',
                },
        });
        const result = await loop.run({ sessionId: state.session.id });
        expect(result.status).toBe('completed');
        expect(await readFile(path.join(state.root, 'p.txt'), 'utf8')).toBe('one\ndeux\nthree\n');
      } finally {
        state.database.close();
      }
    },
    30_000,
  );
});

describe('QA agent: evals harness', () => {
  it('reports a failing scenario correctly without masking it', async () => {
    const report = await runAgentEvals({
      run: async (fixture) => ({
        success: fixture.id !== 'rename-symbol',
        steps: 1,
        tokens: 10,
      }),
    });
    expect(report.mode).toBe('fake');
    expect(report.total).toBe(AGENT_EVALS.length);
    expect(report.passed).toBe(AGENT_EVALS.length - 1);
    const failing = report.results.find((result) => result.id === 'rename-symbol');
    expect(failing?.success).toBe(false);
    expect(report.results.filter((result) => !result.success)).toHaveLength(1);
  });

  it('propagates a thrown scenario instead of silently counting it as a pass', async () => {
    await expect(
      runAgentEvals({
        run: async (fixture) => {
          if (fixture.id === 'fix-failing-test') throw new Error('scenario exploded');
          return { success: true, steps: 1, tokens: 1 };
        },
      }),
    ).rejects.toThrow('scenario exploded');
  });
});

describe('QA agent: real SDK against a scripted fake server', () => {
  it('recovers from malformed tool-call JSON emitted by the provider', async () => {
    const state = await setup();
    try {
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
        id: 'chatcmpl_qa',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      const fake = await FakeOpenAIServer.scriptedTurns([
        {
          chunks: [
            chunk({ role: 'assistant' }),
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{broken' },
                },
              ],
            }),
            chunk({}, 'tool_calls'),
          ],
        },
        {
          chunks: [
            chunk({ role: 'assistant' }),
            chunk({ content: 'recovered' }),
            chunk({}, 'stop'),
          ],
        },
      ]).start();
      try {
        const loop = makeLoop(state, {
          apiKeys: { openai: 'fixture-key' },
          providerFetch: (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            return fetch(new URL(`${url.pathname}${url.search}`, fake.baseUrl), request);
          },
        });
        const result = await loop.run({ sessionId: state.session.id });
        expect(result.status).toBe('completed');
        expect(fake.requests.length).toBe(2);
        expect(textParts(state).some((text) => text.includes('retry once'))).toBe(true);
      } finally {
        await fake.stop();
      }
    } finally {
      state.database.close();
    }
  }, 30_000);
});
