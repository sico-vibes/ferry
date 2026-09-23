import type {
  Checkpoint,
  DelegationRun,
  Lane,
  McpServer,
  Message,
  ModelInfo,
  Profile,
  Provider,
  Session,
  Skill,
  TaskRecord,
  Workspace,
} from '@ferry/shared';
export type ReturnTypeRng = ReturnType<typeof import('./rng.js').createRng>;
export type MockProvider = Provider & { dailyStepBudget?: number };
export interface MockState {
  workspaces: Workspace[];
  sessions: Session[];
  providers: MockProvider[];
  models: ModelInfo[];
  profiles: Profile[];
  messages: Map<string, Message[]>;
  taskRecords: Map<string, TaskRecord>;
  checkpoints: Checkpoint[];
  settings: import('@ferry/shared').Settings;
  lanes: Lane[];
  skills: Skill[];
  mcps: McpServer[];
  delegationRuns: DelegationRun[];
  selections: Map<string, string>;
}
export interface MockStore extends MockState {
  consumeSteps(providerId: Provider['id'], count: number): import('@ferry/shared').CapacitySummary;
  waitForApproval(
    sessionId: import('@ferry/shared').SessionId,
    partId: import('@ferry/shared').PartId,
  ): Promise<'allowed_once' | 'allowed_always' | 'denied'>;
}
