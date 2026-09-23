import type { FerryEvents } from '../../events.js';
import type { Clock } from '../clock.js';
import type { ReturnTypeRng, MockState, MockStore } from '../types.js';
import type { FerryClient } from '../../ferry-client.js';
import type {
  DelegationRun,
  RunId,
  Session,
  SessionDetail,
  SessionId,
  Workspace,
  WorkspaceId,
} from '@ferry/shared';
import type { TypedEmitter } from '../emitter.js';
import type { createFixtures } from '../fixtures/index.js';
import type { ScenarioRunner } from '../scenario.js';
type MockFixtures = ReturnType<typeof createFixtures>;

export interface MockDeps {
  state: MockState;
  clock: Clock;
  rng: ReturnTypeRng;
  fixtures: MockFixtures;
  scenarioRunner: ScenarioRunner;
  store: MockStore;
  emitter: TypedEmitter;
  controllers: Map<string, AbortController>;
  approvalWaiters: Map<string, (v: 'allowed_once' | 'allowed_always' | 'denied') => void>;
  before: () => Promise<void>;
  persist: () => void;
  syncStore: () => void;
  emit: <E extends keyof FerryEvents>(event: E, payload: FerryEvents[E]) => void;
  session: (id: SessionId) => Session;
  workspace: (id: WorkspaceId) => Workspace;
  updateSession: (s: Session) => Session;
  sessionDetail: (id: SessionId) => SessionDetail;
  run: (id: RunId) => DelegationRun;
  scheduleRun: (r: DelegationRun) => void;
  finishRun: (r: DelegationRun) => void;
  capacity: () => import('@ferry/shared').CapacitySummary;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- call sites supply the branded ID type
  stringId: <T extends string>(prefix: string) => T;
}
export type DomainFactory<K extends keyof FerryClient> = (
  store: MockStore,
  deps: MockDeps,
) => FerryClient[K];
