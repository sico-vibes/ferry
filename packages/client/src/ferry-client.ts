import type {
  CapacitySummary,
  Effort,
  ProviderLimits,
  Checkpoint,
  CheckpointId,
  ApprovalsPending,
  CliConnection,
  CliConnectionKind,
  CliConnectionSettingsPatch,
  CliConnectionVerifyResult,
  CliOption,
  SessionModelUsage,
  DelegationRun,
  AcpAgentDetection,
  GatewayRequestRecord,
  GatewayHistoryQuery,
  GatewayHistoryPage,
  GatewayUsageSummary,
  GatewayRoutingExplanation,
  GatewayActivity,
  GatewayConnectionTest,
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
  SettingsPatch,
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
        client?: string;
        profile: string;
        allowedModels: string[];
        rateLimit: number | null;
        tokenLimitPerMinute: number | null;
        tokenLimitPerDay: number | null;
        concurrencyLimit: number | null;
        paidBackup?: boolean;
        budgetUsd?: number | null;
        budgetUsedUsd?: number;
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
        client?: string;
        profile?: string;
        allowedModels?: string[];
        rateLimit?: number | null;
        tokenLimitPerMinute?: number | null;
        tokenLimitPerDay?: number | null;
        concurrencyLimit?: number | null;
        paidBackup?: boolean;
        budgetUsd?: number | null;
        compressToolResults?: boolean;
        terseSystemPrompt?: boolean;
      };
    }): Promise<unknown>;
    revokeKey(id: string): Promise<unknown>;
    /** Recent requests routed by the Gateway, newest first (metadata only, persisted locally). */
    requests(): Promise<GatewayRequestRecord[]>;
    history(input?: GatewayHistoryQuery): Promise<GatewayHistoryPage>;
    request(id: string): Promise<GatewayRequestRecord | null>;
    usage(input?: {
      range?: '24h' | '7d' | '30d';
      groupBy?: 'key' | 'provider' | 'model';
    }): Promise<GatewayUsageSummary>;
    activity(): Promise<GatewayActivity>;
    routing(keyId?: string): Promise<GatewayRoutingExplanation>;
    rotateKey(
      id: string,
    ): Promise<{ key: { id: string; name: string; profile: string }; secret: string }>;
    testConnection(input: {
      id: string;
      protocol?: 'chat' | 'responses' | 'anthropic';
      approvedCostUsd?: number;
    }): Promise<GatewayConnectionTest>;
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
    /** Per-session/model usage aggregate. */
    modelUsage(id: SessionId): Promise<SessionModelUsage>;
    /** Set per-conversation CLI options keyed by the selected model. */
    updateCliOptions(
      id: SessionId,
      input: { modelRef: ModelRef; options: Partial<CliOption> },
    ): Promise<Session>;
    remove(id: SessionId): Promise<void>;
  };
  approvals: {
    respond(
      sessionId: SessionId,
      partId: import('@ferry/shared').PartId,
      decision: 'allow_once' | 'allow_always' | 'deny',
    ): Promise<void>;
    /** Full actionable pending approvals across sessions. */
    pending(): Promise<ApprovalsPending>;
  };
  /** Installed CLI connections: discovery, cached snapshots, opt-ins and verification. */
  cliConnections: {
    /** Immediate cached snapshot; triggers a bounded background refresh when stale. */
    list(): Promise<CliConnection[]>;
    /** Bounded fresh discovery (singleflight) returning the refreshed snapshot. */
    refresh(id?: CliConnectionKind): Promise<CliConnection[]>;
    /** Explicit account/model verification. Real generation adapters are not available yet. */
    verify(id: CliConnectionKind, modelRef?: ModelRef): Promise<CliConnectionVerifyResult>;
    /** Persist surface opt-ins and per-model option defaults. */
    update(id: CliConnectionKind, patch: CliConnectionSettingsPatch): Promise<CliConnection>;
  };
  checkpoints: {
    list(sessionId: SessionId): Promise<Checkpoint[]>;
    diff(id: CheckpointId): Promise<string>;
    restore(id: CheckpointId, paths?: string[]): Promise<void>;
  };
  providers: {
    zenCliStatus(): Promise<{
      available: boolean;
      version: string | null;
      executable: string | null;
      credentialSource: 'opencode' | 'opencode_go' | 'ferry' | 'anonymous';
      verifiedModels: string[];
      freeModels: { ref: string; name: string }[];
    }>;
    verifyZenCli(modelRef?: string): Promise<{ ok: boolean; modelRef: string; message: string }>;
    startChecks(options?: import('@ferry/shared').ProviderCheckOptions): Promise<{ id: string }>;
    checkProgress(id?: string): Promise<import('@ferry/shared').ProviderCheckProgress>;
    cancelChecks(id: string): Promise<import('@ferry/shared').ProviderCheckProgress>;
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
    respond(id: OAuthProviderId, promptId: string, value: string): Promise<void>;
    cancel(id: OAuthProviderId): Promise<void>;
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
    importCodingResults(report: unknown): Promise<{ imported: number; total: number }>;
    list(): Promise<Profile[]>;
    save(p: Profile): Promise<Profile>;
    remove(id: ProfileId): Promise<void>;
    activate(id: ProfileId, sessionId?: SessionId): Promise<void>;
  };
  settings: { get(): Promise<Settings>; update(patch: SettingsPatch): Promise<Settings> };
  optimizer: { stats(): Promise<OptimizerStats> };
  delegation: {
    clients(checkAuth?: boolean): Promise<import('@ferry/shared').DelegationClientStatus[]>;
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
