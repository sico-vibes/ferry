import type {
  Checkpoint,
  DelegationRun,
  Lane,
  McpServer,
  Message,
  ModelInfo,
  Profile,
  Provider,
  ProviderKey,
  Session,
  Skill,
  TaskRecord,
  Workspace,
} from '@ferry/shared';
export type ReturnTypeRng = ReturnType<typeof import('./rng.js').createRng>;
export type MockProvider = Provider & { dailyStepBudget?: number };
/**
 * One retained mock usage event: the equivalent of a durable request row. Token dimensions are
 * nullable so an unreported dimension stays distinct from a reported zero.
 */
export interface MockSessionUsageContribution {
  eventId: string;
  sessionId: string;
  modelRef: string;
  providerId: string | null;
  connectionId: string | null;
  accountKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  occurredAt: string;
  /** True for a fixture-origin row whose per-request detail predates the ledger. */
  backfilled?: boolean;
}
export interface MockState {
  workspaces: Workspace[];
  sessions: Session[];
  providers: MockProvider[];
  requestFailures: import('@ferry/shared').FailureEntry[];
  failureResets: Record<string, string[]>;
  providerKeys: Map<string, ProviderKey[]>;
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
  /**
   * Scripted verification receipts per installed-CLI kind (accumulated model refs), so the mock
   * inventory reacts to Verify and keeps earlier verified models like the real broker.
   */
  cliVerifiedModels: Map<string, string[]>;
  /** Retained mock usage ledger, the source for a session's model-usage aggregate. */
  sessionUsage: MockSessionUsageContribution[];
}
export interface MockStore extends MockState {
  nextId(prefix: string): string;
  consumeSteps(providerId: Provider['id'], count: number): import('@ferry/shared').CapacitySummary;
  /** Retains one usage contribution for a finalized assistant reply (tokens may be unreported). */
  recordUsage(input: MockSessionUsageContribution): void;
  waitForApproval(
    sessionId: import('@ferry/shared').SessionId,
    partId: import('@ferry/shared').PartId,
  ): Promise<'allowed_once' | 'allowed_always' | 'denied'>;
  startDelegation(
    sessionId: import('@ferry/shared').SessionId,
    lane: string,
    brief: string,
  ): Promise<DelegationRun>;
}
