import type {
  CapacitySummary,
  Checkpoint,
  CheckpointId,
  DelegationRun,
  HandoffStat,
  Lane,
  McpServer,
  McpServerId,
  ModelCandidate,
  ModelInfo,
  ModelRef,
  OptimizerStats,
  OAuthProvider,
  OAuthProviderId,
  ProbeResult,
  Profile,
  ProfileId,
  Provider,
  ProviderId,
  RunId,
  Session,
  SessionDetail,
  SessionId,
  Settings,
  Skill,
  SkillId,
  SystemInfo,
  UsageHistoryPoint,
  Workspace,
  WorkspaceId,
  WorkspaceSettings,
} from '@ferry/shared';
import type { FerryEvents } from './events.js';

export interface FerryClient {
  workspaces: {
    list(): Promise<Workspace[]>;
    open(path: string): Promise<Workspace>;
    remove(id: WorkspaceId): Promise<void>;
    update(id: WorkspaceId, patch: Partial<WorkspaceSettings>): Promise<Workspace>;
  };
  sessions: {
    list(q?: { workspaceId?: WorkspaceId; query?: string }): Promise<Session[]>;
    search(q?: { workspaceId?: WorkspaceId; query?: string }): Promise<Session[]>;
    get(id: SessionId): Promise<SessionDetail>;
    create(i: {
      workspaceId: WorkspaceId;
      profileId?: ProfileId;
      title?: string;
    }): Promise<Session>;
    send(id: SessionId, i: { text: string }): Promise<void>;
    cancel(id: SessionId): Promise<void>;
    rename(id: SessionId, title: string): Promise<Session>;
    setStarred(id: SessionId, v: boolean): Promise<Session>;
    setPinned(id: SessionId, v: boolean): Promise<Session>;
    remove(id: SessionId): Promise<void>;
  };
  approvals: {
    respond(
      sessionId: SessionId,
      partId: import('@ferry/shared').PartId,
      decision: 'allow_once' | 'allow_always' | 'deny',
    ): Promise<void>;
  };
  checkpoints: {
    list(sessionId: SessionId): Promise<Checkpoint[]>;
    diff(id: CheckpointId): Promise<string>;
    restore(id: CheckpointId, paths?: string[]): Promise<void>;
  };
  providers: {
    list(): Promise<Provider[]>;
    setKey(id: ProviderId, key: string): Promise<Provider>;
    removeKey(id: ProviderId): Promise<Provider>;
    probe(id: ProviderId): Promise<ProbeResult>;
    setEnabled(id: ProviderId, v: boolean): Promise<Provider>;
  };
  oauth: {
    list(): Promise<OAuthProvider[]>;
    login(id: OAuthProviderId): Promise<void>;
    logout(id: OAuthProviderId): Promise<void>;
    status(id: OAuthProviderId): Promise<boolean>;
  };
  quota: {
    capacity(): Promise<CapacitySummary>;
    history(days: number): Promise<UsageHistoryPoint[]>;
    handoffs(days: number): Promise<HandoffStat[]>;
  };
  models: {
    list(providerId?: ProviderId): Promise<ModelInfo[]>;
    candidates(sessionId: SessionId | null): Promise<ModelCandidate[]>;
    select(sessionId: SessionId, ref: ModelRef | 'auto'): Promise<void>;
  };
  profiles: {
    list(): Promise<Profile[]>;
    save(p: Profile): Promise<Profile>;
    remove(id: ProfileId): Promise<void>;
    activate(id: ProfileId, sessionId?: SessionId): Promise<void>;
  };
  settings: { get(): Promise<Settings>; update(patch: Partial<Settings>): Promise<Settings> };
  optimizer: { stats(): Promise<OptimizerStats> };
  delegation: {
    lanes(): Promise<Lane[]>;
    approveProjectLanes(): Promise<Lane[]>;
    runs(sessionId: SessionId): Promise<DelegationRun[]>;
    start(i: { sessionId: SessionId; lane: string; brief: string }): Promise<DelegationRun>;
    cancel(id: RunId): Promise<void>;
    decide(
      id: RunId,
      decision: 'accepted' | 'rejected' | 'rework',
      reworkBrief?: string,
    ): Promise<DelegationRun>;
  };
  skills: { list(): Promise<Skill[]>; setEnabled(id: SkillId, v: boolean): Promise<Skill> };
  mcp: {
    list(): Promise<McpServer[]>;
    setEnabled(id: McpServerId, v: boolean): Promise<McpServer>;
  };
  system: { info(): Promise<SystemInfo> };
  on<E extends keyof FerryEvents>(event: E, handler: (payload: FerryEvents[E]) => void): () => void;
}
