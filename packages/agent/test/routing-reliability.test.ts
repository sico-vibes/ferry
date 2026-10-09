/* eslint @typescript-eslint/require-await: off */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROUTING_SETTINGS,
  ModelInfoSchema,
  ProviderSchema,
  type QuotaWindow,
  type RoutingSettings,
  type ModelInfo,
} from '@ferry/shared';
import { openDatabase, MessageRepository, SessionRepository, TaskRepository } from '@ferry/storage';
import { BUILTIN_PROFILES } from '@ferry/router';
import { QuotaEngine } from '@ferry/quota';
import { AgentLoop, type AgentOptions, type AgentEvent, type GeneratedStep } from '../src/loop.js';
import { SessionStore } from '../src/session.js';

vi.setConfig({ testTimeout: 30_000 });
const epoch = Date.parse('2026-10-08T12:00:00Z');
const owner = ModelInfoSchema.parse({
  ref: 'groq/owner',
  providerId: 'groq',
  name: 'Owner',
  tier: 'T3',
  contextWindow: 128_000,
  maxOutput: 8192,
  toolCalling: true,
  reasoning: true,
  free: true,
  priceInPerM: 0,
  priceOutPerM: 0,
  quality: 0.9,
});
const alternate = ModelInfoSchema.parse({
  ...owner,
  ref: 'gemini/alternate',
  providerId: 'gemini',
  name: 'Alternate',
  tier: 'T2',
  quality: 0.4,
});
const provider = ProviderSchema.parse({
  id: 'groq',
  name: 'Groq',
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
  stepsLeftToday: 50,
});
function window(resetInSeconds: number, extra: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'minute',
    scope: 'provider',
    modelRef: null,
    metric: 'tokens',
    kind: 'rolling',
    periodLabel: 'per-minute',
    used: 10000,
    remaining: 0,
    limit: 10000,
    confidence: 'exact',
    observedAt: new Date(Date.now()).toISOString(),
    durationMs: 60_000,
    resetAt: new Date(Date.now() + resetInSeconds * 1000).toISOString(),
    ...extra,
  };
}
function error(statusCode: number, message: string, retryAfter?: string): Error {
  return Object.assign(new Error(message), {
    statusCode,
    ...(retryAfter ? { responseHeaders: { 'retry-after': retryAfter } } : {}),
  });
}
const read: GeneratedStep = {
  toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }],
  finishReason: 'tool-calls',
  inputTokens: 100,
  outputTokens: 20,
  reasoningTokens: 4,
};
let root: string;
let database: Awaited<ReturnType<typeof openDatabase>>;
let store: SessionStore;
let sessionId: string;
let events: AgentEvent[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferry-routing-'));
  database = await openDatabase(join(root, 'data', 'db.sqlite'));
  store = new SessionStore({
    sessions: new SessionRepository(database.client),
    messages: new MessageRepository(database.client),
    tasks: new TaskRepository(database.client),
  });
  const profile = BUILTIN_PROFILES[0];
  if (!profile) throw new Error('Missing test profile');
  sessionId = store.create({ profileId: profile.id, prompt: 'Build blog.html, then verify it' }).id;
  await writeFile(join(root, 'README.md'), 'Ferry\n');
  events = [];
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
  vi.setSystemTime(epoch);
});
afterEach(async () => {
  vi.useRealTimers();
  database.close();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
function loop(
  overrides: Partial<AgentOptions> = {},
  settings: Partial<RoutingSettings> = {},
): AgentLoop {
  const profile = BUILTIN_PROFILES[0];
  if (!profile) throw new Error('Missing test profile');
  return new AgentLoop({
    store,
    workspace: root,
    dataDir: join(root, 'data'),
    recent: true,
    profile: { ...profile, roles: { ...profile.roles, enabled: false } },
    catalog: { models: [owner, alternate], providers: [], tiers: {} },
    capacity: () => ({
      providers: [provider, { ...provider, id: alternate.providerId, name: 'Gemini' }],
    }),
    apiKeys: {},
    permissionMode: 'full_auto',
    emit: (event) => events.push(event),
    routingSettings: () => ({ ...DEFAULT_ROUTING_SETTINGS, ...settings }),
    resolveCandidates: () => [owner, alternate],
    ...overrides,
  });
}
const textParts = () =>
  store
    .load(sessionId)
    ?.messages.flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n') ?? '';
async function ready(assertion: () => void): Promise<void> {
  // Generous for slow CI runners; tests still finish as soon as the condition holds.
  const deadline = process.hrtime.bigint() + 20_000_000_000n;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (process.hrtime.bigint() > deadline) throw error;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('routing reliability', () => {
  it('resumes the same model through the real quota lease engine after a 12s header reset', async () => {
    const engine = new QuotaEngine({
      now: () => new Date(),
      catalog: {
        models: [owner, alternate],
        providers: [
          {
            provider: 'groq',
            name: 'Groq',
            tag: 'legit',
            signup_url: null,
            docs_url: null,
            terms_note: '',
            data_use: '',
            verified_at: '2026-10-08',
            source_url: 'https://example.invalid',
            windows: [
              { scope: 'provider', metric: 'tokens', kind: 'rolling', length: 60, limit: 10000 },
            ],
          },
        ],
      },
    });
    try {
      engine.recordUsage({
        id: 'before-reset',
        providerId: owner.providerId,
        modelRef: owner.ref,
        occurredAt: new Date().toISOString(),
        inputTokens: 9000,
        status: 'success',
      });
      const windowId = engine.getWindows('groq')[0]?.id;
      if (!windowId) throw new Error('Missing test window');
      engine.observe({
        id: 'header',
        providerId: owner.providerId,
        windowId,
        metric: 'tokens',
        limit: 10000,
        remaining: 0,
        observedAt: new Date().toISOString(),
        resetAt: new Date(epoch + 12000).toISOString(),
        source: 'header',
      });
      const used: string[] = [];
      const running = loop({
        capacity: () => ({
          providers: [
            { ...provider, windows: engine.getWindows('groq') },
            { ...provider, id: alternate.providerId },
          ],
        }),
        acquireQuotaLease: (model, tokens) =>
          engine.acquireLease(model.providerId, model.ref, tokens) ?? null,
        generator: async ({ model }) => {
          used.push(model.ref);
          return { text: 'Done' };
        },
      }).run({ sessionId });
      await ready(() => {
        expect(
          events.some(
            (event) =>
              event.type === 'agent.event' &&
              event.event.type === 'status' &&
              event.event.status === 'waiting',
          ),
        ).toBe(true);
      });
      await vi.advanceTimersByTimeAsync(12000);
      const result = await running;
      expect(used).toEqual([owner.ref]);
      expect(result.report?.failedAttempts).toEqual([]);
      expect(result.report?.switches).toEqual([]);
      expect(result.report?.waits).toMatchObject([{ provider: 'groq', seconds: 12 }]);
    } finally {
      engine.dispose();
    }
  });
  it.each([false, true])(
    'paces a 12s hard minute window before acquiring a lease (pinned: %s)',
    async (pinned) => {
      const blocked = window(12);
      const lease = vi.fn(() => () => undefined);
      const generate = vi.fn(async () => ({ text: 'Done', finishReason: 'stop' }));
      const run = loop({
        ...(pinned ? { pinnedModelRef: owner.ref } : {}),
        capacity: () => ({
          providers: [{ ...provider, windows: Date.now() < epoch + 12_000 ? [blocked] : [] }],
        }),
        acquireQuotaLease: lease,
        generator: generate,
      }).run({ sessionId });
      await ready(() => {
        expect(
          events.filter(
            (event) =>
              event.type === 'agent.event' &&
              event.event.type === 'status' &&
              event.event.status === 'waiting',
          ),
        ).toHaveLength(1);
      });
      expect(lease).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(12_000);
      const result = await run;
      expect(lease).toHaveBeenCalledTimes(1);
      expect(result.report?.ownerModel).toBe(owner.ref);
      expect(result.report?.waits).toEqual([
        { provider: 'groq', seconds: 12, reason: 'per-minute limit' },
      ]);
      expect(
        store
          .load(sessionId)
          ?.messages.flatMap((message) => message.parts)
          .some((part) => part.type === 'handoff_marker'),
      ).toBe(false);
      expect(
        events.find(
          (event) =>
            event.type === 'agent.event' &&
            event.event.type === 'status' &&
            event.event.status === 'waiting',
        ),
      ).toMatchObject({
        event: {
          waitUntil: new Date(epoch + 12_000).toISOString(),
          message: "Waiting 12s for Groq's per-minute limit",
        },
      });
    },
  );

  it.each([300, 12])(
    'switches for a long wait or a daily window resetting in %ss',
    async (seconds) => {
      const used: string[] = [];
      const result = await loop({
        capacity: () => ({
          providers: [
            {
              ...provider,
              windows: [
                window(
                  seconds,
                  seconds === 12 ? { kind: 'fixed_daily', durationMs: 86400_000 } : {},
                ),
              ],
            },
            { ...provider, id: alternate.providerId },
          ],
        }),
        generator: async ({ model }) => {
          used.push(model.ref);
          return { text: 'Done' };
        },
      }).run({ sessionId });
      expect(used).toEqual([alternate.ref]);
      expect(result.report?.waits).toEqual([]);
    },
  );

  it('keeps the owner when soft alternates are weaker', async () => {
    const used: string[] = [];
    const soft = window(300, {
      remaining: 9000,
      used: 1000,
      durationMs: 86400_000,
      kind: 'fixed_daily',
    });
    const result = await loop({
      capacity: () => ({
        providers: [
          { ...provider, windows: used.length ? [soft] : [], stepsLeftToday: used.length ? 1 : 50 },
          { ...provider, id: alternate.providerId },
        ],
      }),
      generator: async ({ model }) => {
        used.push(model.ref);
        return used.length < 3 ? read : { text: 'Done' };
      },
    }).run({ sessionId });
    expect(used).toEqual([owner.ref, owner.ref, owner.ref]);
    expect(result.report?.switches).toEqual([]);
  });

  it.each([false, true])(
    'returns to the owner on the next eligible step (pinned: %s)',
    async (pinned) => {
      const used: string[] = [];
      const hard = window(300, { durationMs: 86400_000, kind: 'fixed_daily' });
      const result = await loop({
        ...(pinned ? { pinnedModelRef: owner.ref } : {}),
        capacity: () => ({
          providers: [
            { ...provider, windows: used.length === 1 ? [hard] : [] },
            { ...provider, id: alternate.providerId },
          ],
        }),
        generator: async ({ model }) => {
          used.push(model.ref);
          return used.length < 3 ? read : { text: 'Done' };
        },
      }).run({ sessionId });
      expect(used).toEqual([owner.ref, alternate.ref, owner.ref]);
      expect(result.session.ownerModelRef).toBe(owner.ref);
      expect(result.report?.switches.map((entry) => entry.reason)).toEqual([
        'quota',
        'owner_return',
      ]);
    },
  );

  it('returns to the owner at a short reset beyond the wait cap, without a 60s model lock', async () => {
    const used: string[] = [];
    const result = await loop({
      generator: async ({ model }) => {
        used.push(model.ref);
        if (used.length === 2) throw error(429, 'rate limit', '31');
        if (model.ref === alternate.ref) vi.setSystemTime(epoch + 31_000);
        return used.length < 4 ? read : { text: 'Done' };
      },
    }).run({ sessionId });
    expect(used).toEqual([owner.ref, owner.ref, alternate.ref, owner.ref]);
    expect(result.report?.waits).toEqual([]);
    expect(result.report?.ownerModel).toBe(owner.ref);
  });

  it('aborts a generator that never yields at the first-token deadline and falls back', async () => {
    const used: string[] = [];
    let aborted = false;
    const run = loop({
      generator: async ({ model, signal }) => {
        used.push(model.ref);
        if (model.ref === owner.ref) {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise<GeneratedStep>(() => undefined);
        }
        return { text: 'Fallback' };
      },
    }).run({ sessionId });
    await ready(() => {
      expect(used).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await run;
    expect(aborted).toBe(true);
    expect(used).toEqual([owner.ref, alternate.ref]);
    expect(result.report?.failedAttempts).toEqual([{ kind: 'timeout', count: 1 }]);
  });

  it('a stream part stops the first-token deadline, but the progress watchdog still applies', async () => {
    let progress: (() => void) | undefined;
    let resolve!: (value: GeneratedStep) => void;
    const run = loop({
      generator: async ({ onToolDelta }) => {
        progress = onToolDelta;
        return new Promise<GeneratedStep>((done) => {
          resolve = done;
        });
      },
    }).run({ sessionId });
    await ready(() => {
      expect(progress).toBeTypeOf('function');
    });
    progress?.();
    await vi.advanceTimersByTimeAsync(26_000);
    resolve({ text: 'Finished' });
    expect((await run).report?.failedAttempts).toEqual([]);
  });

  it('excludes all five models after one provider-scope auth failure', async () => {
    const siblings: ModelInfo[] = Array.from({ length: 5 }, (_, index) =>
      ModelInfoSchema.parse({ ...owner, ref: `groq/model-${String(index)}` }),
    );
    const models = [...siblings, alternate];
    const used: string[] = [];
    const result = await loop({
      catalog: { models, providers: [], tiers: {} },
      resolveCandidates: () => models,
      generator: async ({ model }) => {
        used.push(model.ref);
        if (model.providerId === 'groq') throw error(401, 'invalid api key');
        return { text: 'Done' };
      },
    }).run({ sessionId });
    expect(used).toEqual([siblings[0]?.ref, alternate.ref]);
    expect(result.report?.failedAttempts).toEqual([{ kind: 'auth', count: 1 }]);
  });

  it('paces a Retry-After 429 without holding its released lease', async () => {
    let calls = 0;
    let held = 0;
    const run = loop({
      acquireQuotaLease: () => {
        held++;
        return () => {
          held--;
        };
      },
      generator: async () => {
        if (++calls === 1) throw error(429, 'Too many requests', '12');
        return { text: 'Done' };
      },
    }).run({ sessionId });
    await ready(() => {
      expect(
        events.some(
          (event) =>
            event.type === 'agent.event' &&
            event.event.type === 'status' &&
            event.event.status === 'waiting',
        ),
      ).toBe(true);
    });
    expect(held).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await run;
    expect(calls).toBe(2);
    expect(result.report?.switches).toEqual([]);
    expect(result.report?.failedAttempts).toEqual([{ kind: 'rate_limit', count: 1 }]);
  });

  it('completes written work with a deterministic warning and persisted report', async () => {
    let calls = 0;
    const result = await loop({
      generator: async () => {
        if (++calls === 1)
          return {
            toolCalls: [
              { name: 'write_file', input: { path: 'blog.html', content: '<h1>Blog</h1>' } },
            ],
            finishReason: 'tool-calls',
          };
        throw error(429, 'daily quota exhausted');
      },
    }).run({ sessionId });
    expect(result.status).toBe('completed');
    expect(result.report?.outcome).toBe('completed_with_warnings');
    expect(result.report?.filesChanged).toEqual([
      { path: 'blog.html', sizeBytes: 13, status: 'added' },
    ]);
    expect(textParts()).toContain('blog.html: 13 bytes (added)');
    expect(textParts()).toContain('Final check skipped');
    expect(result.session.runPhase).toBeUndefined();
    expect(store.load(sessionId)?.session.runReport).toEqual(result.report);
    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({
      outcome: 'completed_with_warnings',
      warnings: result.warnings,
    });
  });

  it('errors on exhaustion without a mutation and still emits a report', async () => {
    await expect(
      loop({
        generator: async () => {
          throw error(429, 'daily quota exhausted');
        },
      }).run({ sessionId }),
    ).rejects.toThrow('All free candidates exhausted');
    expect(store.load(sessionId)?.session.status).toBe('error');
    expect(store.load(sessionId)?.session.runReport?.outcome).toBe('error');
    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({
      outcome: 'error',
    });
  });

  it('preserves written work when a pinned provider rejects the next request capability', async () => {
    let calls = 0;
    const result = await loop(
      {
        pinnedModelRef: owner.ref,
        generator: async () => {
          if (++calls === 1)
            return {
              toolCalls: [{ name: 'write_file', input: { path: 'blog.html', content: 'done' } }],
              finishReason: 'tool-calls',
            };
          throw error(400, 'tool calling not supported');
        },
      },
      { pinnedExhaustion: 'fail' },
    ).run({ sessionId });
    expect(result.report?.outcome).toBe('completed_with_warnings');
    expect(result.report?.failedAttempts).toEqual([{ kind: 'tools_unsupported', count: 1 }]);
  });

  it('user cancellation during pacing remains cancelled even after a mutation', async () => {
    const controller = new AbortController();
    let calls = 0;
    const run = loop({
      generator: async () => {
        if (++calls === 1)
          return {
            toolCalls: [{ name: 'write_file', input: { path: 'blog.html', content: 'done' } }],
            finishReason: 'tool-calls',
          };
        throw error(429, 'rate limit', '12');
      },
    }).run({ sessionId, signal: controller.signal });
    try {
      await ready(() => {
        expect(
          events.some(
            (event) =>
              event.type === 'agent.event' &&
              event.event.type === 'status' &&
              event.event.status === 'waiting',
          ),
        ).toBe(true);
      });
    } finally {
      // Always stop the run before cleanup closes the database.
      controller.abort();
    }
    expect((await run).status).toBe('cancelled');
  }, 30_000);

  it('does not turn a permission denial into completed work with warnings', async () => {
    let calls = 0;
    let approvals = 0;
    const running = loop({
      permissionMode: 'ask',
      requestApproval: async () => (++approvals === 1 ? 'allowed_once' : 'denied'),
      generator: async () => {
        if (++calls <= 2)
          return {
            toolCalls: [
              {
                name: 'write_file',
                input: { path: calls === 1 ? 'blog.html' : 'blocked.txt', content: 'done' },
              },
            ],
            finishReason: 'tool-calls',
          };
        throw error(429, 'daily quota exhausted');
      },
    }).run({ sessionId });
    await expect(running).rejects.toThrow();
    expect(store.load(sessionId)?.session.runReport?.outcome).toBe('error');
  });

  it('does not treat repairable command options as a user denial after writing the deliverable', async () => {
    let calls = 0;
    const result = await loop({
      generator: async () => {
        if (++calls === 1)
          return {
            toolCalls: [
              { name: 'write_file', input: { path: 'blog.html', content: '<h1>Blog</h1>' } },
            ],
            finishReason: 'tool-calls',
          };
        if (calls === 2)
          return {
            toolCalls: [{ name: 'run_command', input: { command: 'echo verify', cwd: root } }],
            finishReason: 'tool-calls',
          };
        throw error(429, 'daily quota exhausted');
      },
    }).run({ sessionId });
    expect(result.report?.outcome).toBe('completed_with_warnings');
    const command = store
      .load(sessionId)
      ?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === 'tool_call' && part.tool === 'run_command');
    expect(command).toMatchObject({
      status: 'failed',
      output: { text: 'Non-default command execution options are not allowed in full-auto mode' },
    });
  });

  it('keeps a declined pinned handover on the error path after a successful mutation', async () => {
    let calls = 0;
    const hard = window(300, { kind: 'fixed_daily', durationMs: 86400_000 });
    const running = loop(
      {
        pinnedModelRef: owner.ref,
        requestApproval: async () => 'denied',
        capacity: () => ({
          providers: [
            { ...provider, windows: calls ? [hard] : [] },
            { ...provider, id: alternate.providerId },
          ],
        }),
        generator: async () => {
          calls++;
          return {
            toolCalls: [{ name: 'write_file', input: { path: 'blog.html', content: 'done' } }],
            finishReason: 'tool-calls',
          };
        },
      },
      { pinnedExhaustion: 'ask' },
    ).run({ sessionId });
    await expect(running).rejects.toThrow('Pinned model');
    expect(store.load(sessionId)?.session.runReport?.outcome).toBe('error');
  });

  it.each([true, false])(
    'counts a successful command only when it changed files (mutates: %s)',
    async (mutates) => {
      vi.useRealTimers();
      let calls = 0;
      const running = loop({
        permissionMode: 'ask',
        requestApproval: async () => 'allowed_once',
        generator: async () => {
          if (++calls === 1)
            return {
              toolCalls: [
                {
                  name: 'run_command',
                  input: { command: mutates ? 'echo changed > command.txt' : 'echo hello' },
                },
              ],
              finishReason: 'tool-calls',
            };
          throw error(429, 'daily quota exhausted');
        },
      }).run({ sessionId });
      if (mutates) {
        const result = await running;
        expect(result.report?.outcome).toBe('completed_with_warnings');
        expect(result.report?.filesChanged).toContainEqual(
          expect.objectContaining({ path: 'command.txt', status: 'added' }),
        );
      } else {
        await expect(running).rejects.toThrow();
        expect(store.load(sessionId)?.session.runReport?.outcome).toBe('error');
      }
    },
  );

  it('exempts local models from the first-token timeout', async () => {
    const local = ModelInfoSchema.parse({ ...owner, ref: 'ollama/local', providerId: 'ollama' });
    let resolve!: (value: GeneratedStep) => void;
    const running = loop({
      catalog: { models: [local], providers: [], tiers: {} },
      resolveCandidates: () => [local],
      capacity: () => ({ providers: [{ ...provider, id: local.providerId }] }),
      generator: async () =>
        new Promise<GeneratedStep>((done) => {
          resolve = done;
        }),
    }).run({ sessionId });
    await ready(() => {
      expect(resolve).toBeTypeOf('function');
    });
    await vi.advanceTimersByTimeAsync(26_000);
    resolve({ text: 'Local answer' });
    expect((await running).report?.failedAttempts).toEqual([]);
  });

  it('enforces the failed-attempt routing deadline without waiting for the progress watchdog', async () => {
    const running = loop({
      routingDeadlineSeconds: 10,
      generator: async () => new Promise<GeneratedStep>(() => undefined),
    }).run({ sessionId });
    const rejected = expect(running).rejects.toThrow('Routing deadline reached');
    await ready(() => {
      expect(
        events.some(
          (event) => event.type === 'session.message' && event.message.role === 'assistant',
        ),
      ).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(store.load(sessionId)?.session.runReport?.failedAttempts).toEqual([
      { kind: 'timeout', count: 1 },
    ]);
  });

  it('excludes a provider after two different 5xx models', async () => {
    const siblings = [
      owner,
      ModelInfoSchema.parse({ ...owner, ref: 'groq/second' }),
      ModelInfoSchema.parse({ ...owner, ref: 'groq/third' }),
    ];
    const used: string[] = [];
    const result = await loop({
      catalog: { models: [...siblings, alternate], providers: [], tiers: {} },
      resilienceState: [
        {
          scope: 'provider',
          key: 'gemini',
          failures: 1,
          expiresAt: new Date(epoch + 300_000).toISOString(),
          lastFamily: 'server',
          strikes: 0,
          strikeWindowEndsAt: new Date(epoch + 600_000).toISOString(),
        },
      ],
      resolveCandidates: () => [...siblings, alternate],
      waitForRetry: async () => undefined,
      generator: async ({ model }) => {
        used.push(model.ref);
        if (model.providerId === 'groq') throw error(502, 'upstream failed');
        return { text: 'Done' };
      },
    }).run({ sessionId });
    expect(used).toEqual([owner.ref, owner.ref, siblings[1]?.ref, alternate.ref]);
    expect(result.report?.failedAttempts).toEqual([{ kind: 'server', count: 3 }]);
  });

  it('allows eight handoffs by default', async () => {
    const candidates = Array.from({ length: 9 }, (_, index) =>
      ModelInfoSchema.parse({ ...owner, ref: `groq/model-${String(index)}` }),
    );
    let calls = 0;
    const result = await loop({
      catalog: { models: candidates, providers: [], tiers: {} },
      resolveCandidates: () => candidates,
      generator: async () => {
        if (++calls < 9) throw error(400, 'tool calling not supported');
        return { text: 'Done' };
      },
    }).run({ sessionId });
    expect(calls).toBe(9);
    expect(result.report?.switches).toHaveLength(8);
  });

  it('reports three steps, one wait, one switch, token splits and the owner', async () => {
    const used: string[] = [];
    const blocked = window(12);
    const run = loop({
      capacity: () => ({
        providers: [
          {
            ...provider,
            windows: used.length === 1 && Date.now() < epoch + 12_000 ? [blocked] : [],
          },
          { ...provider, id: alternate.providerId },
        ],
      }),
      generator: async ({ model }) => {
        used.push(model.ref);
        if (used.length === 3) throw error(401, 'invalid api key');
        return used.length < 3
          ? read
          : { text: 'Done', inputTokens: 30, outputTokens: 5, reasoningTokens: 1 };
      },
    }).run({ sessionId });
    await ready(() => {
      expect(
        events.some(
          (event) =>
            event.type === 'agent.event' &&
            event.event.type === 'status' &&
            event.event.status === 'waiting',
        ),
      ).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(12_000);
    const report = (await run).report;
    expect(report).toMatchObject({
      steps: 3,
      ownerModel: owner.ref,
      modelsUsed: [
        { model: owner.ref, steps: 2 },
        { model: alternate.ref, steps: 1 },
      ],
      switches: [{ from: owner.ref, to: alternate.ref, reason: 'auth', atStep: 3 }],
      waits: [{ provider: 'groq', seconds: 12 }],
      failedAttempts: [{ kind: 'auth', count: 1 }],
      tokens: { input: 230, output: 45, reasoning: 9 },
      outcome: 'completed',
    });
    expect(report?.durationMs).toBeGreaterThanOrEqual(12_000);
  });
});
