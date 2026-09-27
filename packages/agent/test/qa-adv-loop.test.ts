/* eslint
  @typescript-eslint/no-non-null-assertion: off,
  @typescript-eslint/require-await: off,
  @typescript-eslint/no-empty-function: off,
  @typescript-eslint/unbound-method: off
*/
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTING_SETTINGS, ModelInfoSchema, ProviderSchema } from '@ferry/shared';
import type { ModelInfo, RoutingSettings } from '@ferry/shared';
import { openDatabase, MessageRepository, SessionRepository, TaskRepository } from '@ferry/storage';
import { BUILTIN_PROFILES } from '@ferry/router';
import type { RetirementFailure, StickyRoute, ToolRejection } from '@ferry/router';
import { AgentLoop, type AgentOptions } from '../src/loop.js';
import { SessionStore } from '../src/session.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const nowMs = Date.parse('2026-09-27T12:00:00.000Z');

function httpError(
  statusCode: number,
  message: string,
): Error & { statusCode: number; responseBody: string } {
  return Object.assign(new Error(message), {
    statusCode,
    responseBody: JSON.stringify({ error: { message } }),
  });
}

function model(ref: string): ModelInfo {
  const providerId = ref.slice(0, ref.indexOf('/'));
  return ModelInfoSchema.parse({
    ref,
    providerId,
    name: ref,
    tier: 'T2',
    contextWindow: 8_192,
    maxOutput: 2_048,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
  });
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'ferry-qa-adv-'));
  tempDirs.push(root);
  const database = await openDatabase(':memory:');
  const store = new SessionStore({
    sessions: new SessionRepository(database.client),
    messages: new MessageRepository(database.client),
    tasks: new TaskRepository(database.client),
  });
  const provider = ProviderSchema.parse({
    id: 'openai',
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
    modelCount: 2,
    windows: [],
    stepsLeftToday: 50,
  });
  const catalog = {
    models: [model('openai/alpha'), model('openai/beta')],
    providers: [],
    tiers: {},
    warnings: [],
  };
  const session = store.create({
    workspaceId: 'workspace_test' as never,
    profileId: BUILTIN_PROFILES[0]!.id,
    prompt: 'Update the greeting in README.md',
  });
  await writeFile(path.join(root, 'README.md'), '# Ferry\n', 'utf8');
  return { root, database, store, session, provider, catalog };
}

type State = Awaited<ReturnType<typeof setup>>;
const autoFree = BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free')!;

function makeLoop(
  state: State,
  routing: RoutingSettings,
  overrides: Partial<AgentOptions> = {},
): AgentLoop {
  return new AgentLoop({
    store: state.store,
    workspace: state.root,
    dataDir: state.root,
    profile: autoFree,
    catalog: state.catalog,
    capacity: () => ({ providers: [state.provider] }),
    apiKeys: {},
    emit: () => {},
    routingNow: () => nowMs,
    routingSettings: () => routing,
    ...overrides,
    permissionMode: overrides.permissionMode ?? 'full_auto',
  });
}

function routedSettings(overrides: Partial<RoutingSettings> = {}): RoutingSettings {
  return { ...DEFAULT_ROUTING_SETTINGS, ...overrides };
}

describe('QA adv: sticky sessions', () => {
  it('releases the sticky pin when the pinned model starts failing mid-session', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const beta = state.catalog.models[1]!;
      const stickyState: Record<string, StickyRoute> = {
        [state.session.id]: { modelRef: alpha.ref, expiresAt: nowMs + 60 * 60_000 },
      };
      const snapshots: Record<string, StickyRoute>[] = [];
      const calls: string[] = [];
      const loop = makeLoop(state, routedSettings(), {
        stickyState,
        onStickyState: (entries) => snapshots.push(entries),
        resolveCandidates: () => [alpha, beta],
        generator: async ({ model: selected }) => {
          calls.push(selected.ref);
          if (selected.ref === alpha.ref) throw httpError(429, 'Too many requests');
          return { text: 'done', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(calls).toEqual([alpha.ref, beta.ref]);
      expect(snapshots.some((snapshot) => !(state.session.id in snapshot))).toBe(true);
      expect(snapshots.at(-1)?.[state.session.id]?.modelRef).toBe(beta.ref);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('ignores the sticky pin entirely when stickySessions is off', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const beta = state.catalog.models[1]!;
      const stickyState: Record<string, StickyRoute> = {
        [state.session.id]: { modelRef: alpha.ref, expiresAt: nowMs + 60 * 60_000 },
      };
      const calls: string[] = [];
      const loop = makeLoop(state, routedSettings({ stickySessions: false }), {
        stickyState,
        resolveCandidates: () => [beta, alpha],
        generator: async ({ model: selected }) => {
          calls.push(selected.ref);
          return { text: 'done', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      expect(calls[0]).toBe(beta.ref);
    } finally {
      state.database.close();
    }
  }, 30_000);
});

describe('QA adv: reliability toggle flipped mid-run', () => {
  it('stops recording outcomes on the next step after the toggle flips', async () => {
    const state = await setup();
    try {
      const routing = routedSettings({ smartReliability: true, stickySessions: false });
      const reliabilityCalls: number[] = [];
      let generated = 0;
      const loop = makeLoop(state, routing, {
        reliabilityState: [],
        onReliabilityState: (entries) => reliabilityCalls.push(entries.length),
        generator: async () => {
          generated++;
          if (generated === 2) routing.smartReliability = false;
          if (generated <= 2)
            return {
              toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }],
              finishReason: 'tool-calls',
            };
          return { text: 'done', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(generated).toBe(3);
      expect(reliabilityCalls).toEqual([1]);
    } finally {
      state.database.close();
    }
  }, 30_000);
});

describe('QA adv: quota leases', () => {
  it('acquires and releases a lease around a successful generation', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const release = vi.fn();
      const acquire = vi.fn(() => release);
      const loop = makeLoop(state, routedSettings({ quotaReservations: true }), {
        resolveCandidates: () => [alpha],
        acquireQuotaLease: acquire,
        generator: async () => ({ text: 'done', finishReason: 'stop' }),
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('releases the lease when the generator throws', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const release = vi.fn();
      const loop = makeLoop(state, routedSettings({ quotaReservations: true }), {
        resolveCandidates: () => [alpha],
        acquireQuotaLease: () => release,
        generator: async () => {
          throw httpError(429, 'Too many requests');
        },
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('releases the lease when the run is cancelled', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const release = vi.fn();
      const controller = new AbortController();
      let started: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const loop = makeLoop(state, routedSettings({ quotaReservations: true }), {
        resolveCandidates: () => [alpha],
        acquireQuotaLease: () => release,
        generator: async ({ signal }) => {
          started();
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
      await ready;
      controller.abort();
      expect((await running).status).toBe('cancelled');
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('BUG: a lease leaks when the step watchdog fires and the generator ignores the abort', async () => {
    // runWithStepWatchdog rejects on timeout, but the lease release lives in
    // a `finally` that only runs when the generator promise settles. A stalled
    // provider that ignores the abort signal holds the reservation for its TTL.
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const release = vi.fn();
      const loop = makeLoop(state, routedSettings({ quotaReservations: true }), {
        stepTimeoutMs: 50,
        resolveCandidates: () => [alpha],
        acquireQuotaLease: () => release,
        generator: async () => new Promise(() => {}),
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      state.database.close();
    }
  }, 30_000);
});

describe('QA adv: tool-rejection deferral', () => {
  const rejections: ToolRejection[] = [1, 2, 3].map((index) => ({
    modelRef: 'openai/alpha',
    requestId: `request-${String(index)}`,
    at: nowMs - 1_000,
  }));

  it('deprioritizes a deferred model while the technique is on', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const beta = state.catalog.models[1]!;
      const calls: string[] = [];
      const loop = makeLoop(state, routedSettings({ toolRejectionMemory: true }), {
        toolRejectionState: rejections,
        resolveCandidates: () => [alpha, beta],
        generator: async ({ model: selected }) => {
          calls.push(selected.ref);
          return { text: 'done', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      expect(calls[0]).toBe(beta.ref);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('ignores the same history when the technique is off', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const beta = state.catalog.models[1]!;
      const calls: string[] = [];
      const loop = makeLoop(state, routedSettings({ toolRejectionMemory: false }), {
        toolRejectionState: rejections,
        resolveCandidates: () => [alpha, beta],
        generator: async ({ model: selected }) => {
          calls.push(selected.ref);
          return { text: 'done', finishReason: 'stop' };
        },
      });
      await loop.run({ sessionId: state.session.id });
      expect(calls[0]).toBe(alpha.ref);
    } finally {
      state.database.close();
    }
  }, 30_000);
});

describe('QA adv: model-retirement corroboration', () => {
  it('does not retire on one transient 404 but does after a second distinct request', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const failures: RetirementFailure[] = [];
      const retiredFirst: string[][] = [];
      const first = makeLoop(state, routedSettings({ carefulModelRetirement: true }), {
        catalog: { ...state.catalog, models: [alpha] },
        resolveCandidates: () => [alpha],
        onRetirementFailureState: (entries) => {
          failures.splice(0, failures.length, ...entries);
        },
        onRetiredModelRefs: (entries) => retiredFirst.push(entries),
        generator: async () => {
          throw httpError(404, 'model not found');
        },
      });
      await expect(first.run({ sessionId: state.session.id })).rejects.toThrow();
      expect(retiredFirst).toEqual([]);
      expect(failures).toHaveLength(1);

      const session2 = state.store.create({
        workspaceId: state.session.workspaceId,
        profileId: state.session.profileId,
        prompt: 'Try again',
      });
      const retiredSecond: string[][] = [];
      const second = makeLoop(state, routedSettings({ carefulModelRetirement: true }), {
        catalog: { ...state.catalog, models: [alpha] },
        resolveCandidates: () => [alpha],
        retirementFailureState: failures,
        onRetiredModelRefs: (entries) => retiredSecond.push(entries),
        generator: async () => {
          throw httpError(404, 'model not found');
        },
      });
      await expect(second.run({ sessionId: session2.id })).rejects.toThrow();
      expect(retiredSecond.at(-1)).toContain(alpha.ref);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('never retires when carefulModelRetirement is off', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const onRetired = vi.fn();
      const loop = makeLoop(state, routedSettings({ carefulModelRetirement: false }), {
        catalog: { ...state.catalog, models: [alpha] },
        resolveCandidates: () => [alpha],
        retirementFailureState: [{ modelRef: alpha.ref, requestId: 'prior', at: nowMs - 1_000 }],
        onRetiredModelRefs: onRetired,
        generator: async () => {
          throw httpError(404, 'model not found');
        },
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow();
      expect(onRetired).not.toHaveBeenCalled();
    } finally {
      state.database.close();
    }
  }, 30_000);
});

describe('QA adv: request_too_large and pinned models', () => {
  it('hands a 413 to the fallback and never cools the provider', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const beta = state.catalog.models[1]!;
      const calls: string[] = [];
      let resilienceEntries = 0;
      let generated = 0;
      const loop = makeLoop(state, routedSettings(), {
        resolveCandidates: () => [alpha, beta],
        onResilienceState: (entries) => {
          resilienceEntries += entries.length;
        },
        generator: async ({ model: selected }) => {
          calls.push(selected.ref);
          if (selected.ref === alpha.ref) throw httpError(413, 'Request too large for model');
          generated++;
          if (generated === 1)
            return {
              toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }],
              finishReason: 'tool-calls',
            };
          return { text: 'done', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      expect(calls[0]).toBe(alpha.ref);
      expect(calls.slice(1)).not.toContain(alpha.ref);
      expect(resilienceEntries).toBe(0);
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('treats a pinned model failure as terminal instead of handing off', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const beta = state.catalog.models[1]!;
      const calls: string[] = [];
      const onHandoff = vi.fn();
      const loop = makeLoop(state, routedSettings(), {
        pinnedModelRef: alpha.ref,
        resolveCandidates: () => [alpha, beta],
        onHandoff,
        generator: async ({ model: selected }) => {
          calls.push(selected.ref);
          throw httpError(429, 'Too many requests');
        },
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow();
      expect(calls).toEqual([alpha.ref]);
      expect(onHandoff).not.toHaveBeenCalled();
    } finally {
      state.database.close();
    }
  }, 30_000);
});

describe('QA adv: exhaustion and handoff budget', () => {
  it('throws a clear typed error and marks the session errored when all candidates fail', async () => {
    const state = await setup();
    try {
      const alpha = state.catalog.models[0]!;
      const loop = makeLoop(state, routedSettings(), {
        catalog: { ...state.catalog, models: [alpha] },
        resolveCandidates: () => [alpha],
        generator: async () => {
          throw httpError(429, 'Too many requests');
        },
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(
        /No eligible unlocked model remains/,
      );
      expect(state.store.load(state.session.id)?.session.status).toBe('error');
    } finally {
      state.database.close();
    }
  }, 30_000);

  it('stops after the per-step handoff budget is exhausted', async () => {
    const state = await setup();
    try {
      const loop = makeLoop(state, routedSettings(), {
        maxHandoffsPerStep: 0,
        resolveCandidates: () => [...state.catalog.models],
        generator: async () => {
          throw httpError(429, 'Too many requests');
        },
      });
      await expect(loop.run({ sessionId: state.session.id })).rejects.toThrow(
        /Routing stopped after 0 handoffs/,
      );
    } finally {
      state.database.close();
    }
  }, 30_000);
});
