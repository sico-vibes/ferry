import type {
  CapacitySummary,
  Effort,
  ProviderLimits,
  Checkpoint,
  CheckpointId,
  DelegationRun,
  AcpAgentDetection,
  GatewayRequestRecord,
  HandoffStat,
  Lane,
  McpServer,
  McpServerId,
  ModelCandidate,
  ModelInfo,
  Tier,
  ModelRef,
  OptimizerStats,
  OAuthProvider,
  OAuthProviderId,
  ProbeResult,
  Profile,
  ProfileId,
  Provider,
  ProviderId,
  ProviderRequestOverrides,
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
  ReadOutputInput,
  ReadOutputPage,
} from '@ferry/shared';
import type { FerryEvents } from './events.js';

export interface FerryClient {
  cloud: {
    status(): Promise<CloudStatus>;
    signIn(input: { email: string; password: string }): Promise<CloudStatus>;
    signOut(): Promise<void>;
    setStorageMode(input: {
      mode: 'local' | 'cloud';
    }): Promise<{ mode: 'local' | 'cloud'; restartRequired: boolean }>;
    syncNow(): Promise<unknown>;
    setCaptureContent(input: { value: boolean | null }): Promise<boolean | undefined>;
    migrateLocalKeys(): Promise<{ migrated: number; missing: number; failed: number }>;
  };
  gateway: {
    keySecret(id: string): Promise<string>;
    settings(): Promise<{
      enabled: boolean;
      port: number;
      allowLan: boolean;
      status: { running: boolean; port: number | null; host: string | null; url: string | null };
    }>;
    setSettings(input: {
      enabled: boolean;
      port: number;
      allowLan: boolean;
      confirmLan?: boolean;
    }): Promise<unknown>;
    listKeys(): Promise<
      {
        id: string;
        name: string;
        profile: string;
        allowedModels: string[];
        rateLimit: number | null;
        tokenLimitPerMinute: number | null;
        tokenLimitPerDay: number | null;
        concurrencyLimit: number | null;
        compressToolResults: boolean;
        terseSystemPrompt: boolean;
        createdAt: string;
        lastUsedAt: string | null;
        revokedAt: string | null;
        usage: {
          requests: number;
          successfulRequests: number;
          inputTokens: number;
          outputTokens: number;
        };
      }[]
    >;
    createKey(input: {
      name: string;
      profile: string;
    }): Promise<{ key: { id: string; name: string; profile: string }; secret: string }>;
    updateKey(input: {
      id: string;
      patch: {
        profile?: string;
        allowedModels?: string[];
        rateLimit?: number | null;
        tokenLimitPerMinute?: number | null;
        tokenLimitPerDay?: number | null;
        concurrencyLimit?: number | null;
        compressToolResults?: boolean;
        terseSystemPrompt?: boolean;
      };
    }): Promise<unknown>;
    revokeKey(id: string): Promise<unknown>;
    /** Recent requests routed by the Gateway, newest first (metadata only, kept in memory). */
    requests(): Promise<GatewayRequestRecord[]>;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
  };
  workspaces: {
    list(): Promise<Workspace[]>;
    open(path: string): Promise<Workspace>;
    remove(id: WorkspaceId): Promise<void>;
    update(
      id: WorkspaceId,
      patch: Partial<WorkspaceSettings> & {
        name?: string;
        pinned?: boolean;
        settings?: Partial<WorkspaceSettings>;
      },
    ): Promise<Workspace>;
    archiveChats(id: WorkspaceId): Promise<void>;
    searchFiles(input: {
      workspaceId: WorkspaceId;
      query: string;
      limit?: number;
    }): Promise<{ path: string; name: string }[]>;
    trust(id: WorkspaceId): Promise<Workspace>;
  };
  sessions: {
    list(q?: {
      workspaceId?: WorkspaceId | null;
      query?: string;
      includeArchived?: boolean;
    }): Promise<Session[]>;
    search(q?: {
      workspaceId?: WorkspaceId | null;
      query?: string;
      includeArchived?: boolean;
    }): Promise<(Session & { match: string })[]>;
    archive(id: SessionId, archived: boolean): Promise<Session>;
    move(id: SessionId, workspaceId: WorkspaceId | null): Promise<Session>;
    get(id: SessionId): Promise<SessionDetail>;
    readOutput(input: ReadOutputInput): Promise<ReadOutputPage>;
    create(i: {
      workspaceId?: WorkspaceId | null;
      profileId?: ProfileId;
      title?: string;
    }): Promise<Session>;
    send(
      id: SessionId,
      i: {
        text: string;
        attachments?: { name: string; text: string }[];
        maxSteps?: number;
        verbose?: boolean;
        routingMode?: 'auto_for_step';
      },
    ): Promise<void>;
    compact(id: SessionId): Promise<Session>;
    resume(id: SessionId, options?: { retryInterruptedTool?: boolean }): Promise<void>;
    cancel(id: SessionId): Promise<void>;
    rename(id: SessionId, title: string): Promise<Session>;
    setStarred(id: SessionId, v: boolean): Promise<Session>;
    setPinned(id: SessionId, v: boolean): Promise<Session>;
    setEffort(id: SessionId, effort: Effort | null): Promise<Session>;
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
    failures(
      providerId?: ProviderId,
      options?: import('@ferry/shared').FailureOptions,
    ): Promise<import('@ferry/shared').ProviderFailures>;
    resume(id: ProviderId): Promise<Provider>;
    clearFailures(id: ProviderId): Promise<void>;
    health(): Promise<import('@ferry/shared').ProviderHealthSnapshot[]>;
    list(): Promise<Provider[]>;
    listKeys(id: ProviderId): Promise<import('@ferry/shared').ProviderKey[]>;
    effectiveOverrides(id: ProviderId): Promise<ProviderRequestOverrides>;
    setKey(id: ProviderId, key: string): Promise<Provider>;
    addKey(
      id: ProviderId,
      label: string,
      key: string,
    ): Promise<import('@ferry/shared').ProviderKey>;
    removeKey(id: ProviderId): Promise<Provider>;
    removeKeyEntry(id: ProviderId, keyId: string): Promise<void>;
    setKeyEnabled(id: ProviderId, keyId: string, enabled: boolean): Promise<void>;
    reorderKeys(id: ProviderId, keyIds: string[]): Promise<void>;
    setAutoDisablePolicy(
      id: ProviderId,
      policy: {
        enabled: boolean;
        failureCount: number;
        failureWindowMinutes: number;
        statusCodes: number[];
        keywords: string[];
        disableMinutes: number;
      },
    ): Promise<Provider>;
    probe(id: ProviderId, keyId?: string): Promise<ProbeResult>;
    setEnabled(id: ProviderId, v: boolean): Promise<Provider>;
    setBillingEnabled(id: ProviderId, v: boolean): Promise<Provider>;
  };
  oauth: {
    list(): Promise<OAuthProvider[]>;
    login(id: OAuthProviderId, options?: { gateway?: string }): Promise<void>;
    logout(id: OAuthProviderId): Promise<void>;
    status(id: OAuthProviderId): Promise<boolean>;
  };
  quota: {
    capacity(): Promise<CapacitySummary>;
    limits(): Promise<ProviderLimits[]>;
    history(days: number): Promise<UsageHistoryPoint[]>;
    handoffs(days: number): Promise<HandoffStat[]>;
  };
  models: {
    list(providerId?: ProviderId): Promise<ModelInfo[]>;
    page(query?: ModelListQuery): Promise<ModelListResult>;
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
    detectAgents(): Promise<AcpAgentDetection[]>;
    approveProjectLanes(): Promise<Lane[]>;
    approveProjectConfig(): Promise<{ approved: boolean; hash: string | null }>;
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

export interface CloudStatus {
  /** Saved choice; takes effect after a restart when it differs from runningMode. */
  storageMode: 'local' | 'cloud';
  /** Mode this engine process started in. */
  runningMode?: 'local' | 'cloud';
  /** Non-null when a restart is needed to apply the saved storage mode. */
  pendingMode?: 'local' | 'cloud' | null;
  configured: boolean;
  ownerEmail: string | null;
  message: string | null;
  auth: { signedIn: boolean; email: string | null; userId: string | null; isOwner: boolean };
  sync: { pending: number; failed: number; lastError: string | null; lastFlush: string | null };
}

export async function listAllModels(client: FerryClient): Promise<ModelInfo[]> {
  const first = await client.models.page({ offset: 0, limit: 100 });
  const remaining: ModelInfo[] = [];
  for (let offset = first.items.length; offset < first.total; offset += 100) {
    const page = await client.models.page({ offset, limit: 100 });
    remaining.push(...page.items);
    if (page.items.length === 0) break;
  }
  return [...first.items, ...remaining];
}

export type ModelListSort =
  | 'name'
  | 'providerId'
  | 'tier'
  | 'contextWindow'
  | 'toolCalling'
  | 'free'
  | 'priceInPerM'
  | 'priceOutPerM';

export interface ModelListQuery {
  offset?: number;
  limit?: number;
  query?: string;
  filters?: {
    providerId?: ProviderId;
    tier?: Tier;
    free?: boolean;
  };
  sort?: { key: ModelListSort; ascending?: boolean };
}

export interface ModelListResult {
  items: ModelInfo[];
  total: number;
}
