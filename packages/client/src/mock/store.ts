import {
  CheckpointSchema,
  DelegationRunSchema,
  LaneSchema,
  McpServerSchema,
  MessageSchema,
  ModelInfoSchema,
  ProfileSchema,
  SessionDetailSchema,
  SessionSchema,
  SettingsSchema,
  SkillSchema,
  TaskRecordSchema,
  WorkspaceSchema,
  ProviderSchema,
  newId,
} from '@ferry/shared';
import type {
  CapacitySummary,
  DelegationRun,
  RunId,
  Session,
  SessionDetail,
  SessionId,
  Workspace,
  WorkspaceId,
} from '@ferry/shared';
import { TypedEmitter } from './emitter.js';
import { computeCapacity } from './capacity.js';
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import { createRng } from './rng.js';
import { memoryStorage } from './storage.js';
import type { StorageAdapter } from './storage.js';
import { MockInjectedError } from './behavior.js';
import type { MockBehavior } from './behavior.js';
import { createFixtures } from './fixtures/index.js';
import { echoRunner } from './scenario.js';
import type { ScenarioRunner } from './scenario.js';
import type { MockState, MockStore } from './types.js';
import type { MockDeps } from './domains/deps.js';
import type { FerryEvents } from '../events.js';

import { MockNotFoundError } from './errors.js';
const persistenceSchema = (state: unknown) => {
  if (typeof state !== 'object' || state === null) throw new Error('Invalid persisted state');
  const value = state as Record<string, unknown>;
  const workspaces = (value.workspaces as unknown[]).map((x) => WorkspaceSchema.parse(x));
  const sessions = (value.sessions as unknown[]).map((x) => SessionSchema.parse(x));
  const providers = (value.providers as unknown[]).map((x) => ProviderSchema.parse(x));
  const models = (value.models as unknown[]).map((x) => ModelInfoSchema.parse(x));
  const profiles = (value.profiles as unknown[]).map((x) => ProfileSchema.parse(x));
  const settings = SettingsSchema.parse(value.settings);
  const checkpoints = (value.checkpoints as unknown[]).map((x) => CheckpointSchema.parse(x));
  const lanes = (value.lanes as unknown[]).map((x) => LaneSchema.parse(x));
  const skills = (value.skills as unknown[]).map((x) => SkillSchema.parse(x));
  const mcps = (value.mcps as unknown[]).map((x) => McpServerSchema.parse(x));
  const delegationRuns = (value.delegationRuns as unknown[]).map((x) =>
    DelegationRunSchema.parse(x),
  );
  const messages = new Map(
    (value.messages as [string, unknown[]][]).map(([id, rows]) => [
      id,
      rows.map((x) => MessageSchema.parse(x)),
    ]),
  );
  const taskRecords = new Map(
    (value.taskRecords as [string, unknown][]).map(([id, task]) => [
      id,
      TaskRecordSchema.parse(task),
    ]),
  );
  const selections = new Map(value.selections as [string, string][]);
  return {
    ...value,
    workspaces,
    sessions,
    providers,
    models,
    profiles,
    settings,
    checkpoints,
    lanes,
    skills,
    mcps,
    delegationRuns,
    messages,
    taskRecords,
    selections,
  } as Partial<MockState>;
};

export interface MockOptions {
  clock?: Clock;
  storage?: StorageAdapter;
  seed?: number;
  behavior?: 'test' | 'live';
  scenarioRunner?: ScenarioRunner;
}

export interface MockRuntime {
  state: MockState;
  store: MockStore;
  deps: MockDeps;
  reset: () => void;
}

export function createMockStore(options: MockOptions = {}): MockRuntime {
  const clock = options.clock ?? systemClock,
    rng = createRng(options.seed ?? 20260923),
    storage = options.storage ?? memoryStorage(),
    emitter = new TypedEmitter();
  const fixtures = createFixtures(clock.now());
  const initial = (): MockState => ({
    workspaces: structuredClone(fixtures.workspaces),
    sessions: structuredClone(fixtures.sessions),
    providers: structuredClone(fixtures.providers),
    models: structuredClone(fixtures.models),
    profiles: structuredClone(fixtures.profiles),
    messages: new Map(fixtures.messages),
    taskRecords: new Map(fixtures.taskRecords),
    checkpoints: structuredClone(fixtures.checkpoints),
    settings: structuredClone(fixtures.settings),
    lanes: structuredClone(fixtures.lanes),
    skills: structuredClone(fixtures.skills),
    mcps: structuredClone(fixtures.mcps),
    delegationRuns: [],
    selections: new Map(),
  });
  let state = initial();
  const saved = storage.load();
  try {
    if (saved && typeof saved === 'object' && (saved as { version?: unknown }).version === 1) {
      const restored = persistenceSchema((saved as { data: unknown }).data);
      state = {
        ...state,
        ...restored,
        providers: (restored.providers ?? state.providers).map((provider) => {
          const budget = fixtures.providers.find(
            (fixture) => fixture.id === provider.id,
          )?.dailyStepBudget;
          return { ...provider, ...(budget === undefined ? {} : { dailyStepBudget: budget }) };
        }),
        delegationRuns:
          ((restored as Record<string, unknown>).delegationRuns as DelegationRun[] | undefined) ??
          [],
      };
    }
  } catch {
    state = initial();
  }
  const persist = () => {
    storage.save({
      version: 1,
      data: {
        ...state,
        messages: [...state.messages],
        taskRecords: [...state.taskRecords],
        selections: [...state.selections],
      },
    });
  };
  const store: MockStore = {
    ...state,
    consumeSteps(providerId, count) {
      const provider = state.providers.find((candidate) => candidate.id === providerId);
      if (!provider) throw new MockNotFoundError('Provider', providerId);
      provider.stepsLeftToday = Math.max(0, (provider.stepsLeftToday ?? 0) - Math.max(0, count));
      const window = provider.windows.find((candidate) => candidate.metric === 'requests');
      if (window) {
        window.used += Math.max(0, count);
        if (window.limit !== null) window.remaining = Math.max(0, window.limit - window.used);
      }
      const summary = computeCapacity(state.providers, clock.now());
      persist();
      emit('quota.updated', summary);
      return summary;
    },
    waitForApproval(sessionId, partId) {
      return new Promise((resolve) => approvalWaiters.set(`${sessionId}:${partId}`, resolve));
    },
  };
  const syncStore = () => Object.assign(store, state);
  const approvalWaiters = new Map<
    string,
    (v: 'allowed_once' | 'allowed_always' | 'denied') => void
  >();
  const controllers = new Map<string, AbortController>();
  const behavior: MockBehavior = {
    get latency() {
      return options.behavior === 'live' && state.settings.developer.mockLatency;
    },
    get injectErrors() {
      return options.behavior === 'live' && state.settings.developer.injectErrors;
    },
  };
  const before = async () => {
    if (behavior.latency)
      await new Promise<void>((resolve) => clock.setTimeout(resolve, rng.int(50, 400)));
    if (behavior.injectErrors && rng.next() < 0.1) throw new MockInjectedError();
  };
  const emit = <E extends keyof FerryEvents>(event: E, payload: FerryEvents[E]) => {
    emitter.emit(event, payload);
  };
  const session = (id: SessionId): Session => {
    const found = state.sessions.find((item) => item.id === id);
    if (!found) throw new MockNotFoundError('Session', id);
    return found;
  };
  const workspace = (id: WorkspaceId): Workspace => {
    const found = state.workspaces.find((item) => item.id === id);
    if (!found) throw new MockNotFoundError('Workspace', id);
    return found;
  };
  const updateSession = (value: Session): Session => {
    SessionSchema.parse(value);
    emit('session.updated', value);
    persist();
    return value;
  };
  const sessionDetail = (id: SessionId): SessionDetail =>
    SessionDetailSchema.parse({
      session: session(id),
      messages: state.messages.get(id) ?? [],
      taskRecord: state.taskRecords.get(id) ?? {
        sessionId: id,
        goal: '',
        plan: [],
        decisions: [],
        touchedFiles: [],
        nextStep: null,
      },
    });
  const deps: MockDeps = {
    state,
    clock,
    rng,
    fixtures,
    store,
    emitter,
    controllers,
    approvalWaiters,
    before,
    persist,
    syncStore,
    emit,
    session,
    workspace,
    updateSession,
    sessionDetail,
    run,
    scheduleRun,
    finishRun,
    capacity,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- call sites supply the branded ID type
    stringId: <T extends string>(prefix: string): T => newId(prefix) as T,
    scenarioRunner: options.scenarioRunner ?? echoRunner,
  };
  function run(id: RunId) {
    const r = state.delegationRuns.find((x) => x.id === id);
    if (!r) throw new MockNotFoundError('Delegation run', id);
    return r;
  }
  function scheduleRun(r: DelegationRun) {
    clock.setTimeout(() => {
      if (r.status !== 'queued') return;
      r.status = 'running';
      r.progress.push({ at: clock.now().toISOString(), text: 'Agent started' });
      emit('delegation.updated', r);
      persist();
      for (let i = 1; i <= 3; i++)
        clock.setTimeout(() => {
          if (r.status !== 'running') return;
          r.progress.push({
            at: clock.now().toISOString(),
            text: ['Inspecting task', 'Implementing changes', 'Running checks'][i - 1] ?? 'Working',
          });
          emit('delegation.updated', r);
          persist();
          if (i === 3) finishRun(r);
        }, i * 800);
    }, 400);
  }
  function finishRun(r: DelegationRun) {
    if (r.status !== 'running') return;
    r.status = 'completed';
    r.finishedAt = clock.now().toISOString();
    r.finalMessage = 'Implemented the requested change and verified the relevant gates.';
    r.touchedFiles = [
      {
        path: 'src/index.ts',
        status: 'modified',
        additions: 12,
        deletions: 3,
        before: 'export {}',
        after: 'export const ready = true;',
      },
      {
        path: 'test/index.test.ts',
        status: 'added',
        additions: 8,
        deletions: 0,
        before: null,
        after: 'expect(true).toBe(true);',
      },
    ];
    r.gateResults = [
      { command: 'pnpm test', ok: true, outputTail: 'All tests passed' },
      { command: 'pnpm lint', ok: true, outputTail: 'No issues found' },
    ];
    r.usage = { inputTokens: 2300, outputTokens: 680, costUsd: null };
    emit('delegation.updated', r);
    persist();
  }
  function capacity(): CapacitySummary {
    return computeCapacity(state.providers, clock.now());
  }

  return {
    state,
    store,
    deps,
    reset: () => {
      Object.assign(state, initial());
      syncStore();
      persist();
    },
  };
}
