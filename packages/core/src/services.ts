import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLogger, getDataPaths, type DataPaths } from '@ferry/config';
import { KeyringSecretStore, MemorySecretStore, type SecretStore } from '@ferry/secrets';
import { loadCatalog, type Catalog } from '@ferry/catalog';
import { QuotaEngine } from '@ferry/quota';
import { autoDisableUntil, parseOpenRouterKey, type KeyFailure } from '@ferry/providers';
import {
  QuotaObservationSchema,
  newId,
  redactKnownSecretText,
  resolveCaptureContent,
} from '@ferry/shared';
import { canonicalizePath } from '@ferry/shared/node-paths';
import {
  CloudAuthService,
  CloudSyncWorker,
  createCloudRuntime,
  applyHydratedRows,
  type FerrySupabaseClient,
  isCloudConfigured,
  loadCloudConfig,
  type CloudAuthStatus,
  migrateLocalKeysToVault,
  type KeyMigrationCounts,
} from '@ferry/cloud';
import {
  WorkspaceRepository,
  SessionRepository,
  CheckpointRepository,
  DelegationRepository,
  OptimizerEventRepository,
  MessageRepository,
  TaskRepository,
  ProviderRepository,
  ModelCacheRepository,
  ProviderKeyRepository,
  ProviderKeyEntryRepository,
  ProviderKeyUsageDailyRepository,
  CooldownRepository,
  QuotaObservationRepository,
  HandoffRepository,
  SettingsRepository,
  EventLogRepository,
  openDatabase,
  OutboxRepository,
  createStorageAdapter,
  salvageReadableTables,
  type DatabaseConnection,
  type ProviderKeyEntry,
} from '@ferry/storage';

export interface FerryClock {
  now(): Date;
}

export interface ServiceOptions {
  dataDir: string;
  clock?: FerryClock;
  random?: () => number;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  /** Supplies a fake or alternate Supabase client for cloud runtime tests. */
  cloudClientFactory?: (config: import('@ferry/cloud').CloudConfig) => FerrySupabaseClient;
}

export interface FerryServices {
  readonly dataDir: string;
  readonly paths: DataPaths;
  readonly clock: FerryClock;
  readonly random: () => number;
  readonly env: NodeJS.ProcessEnv;
  readonly db: DatabaseConnection;
  readonly settings: SettingsRepository;
  readonly workspaces: WorkspaceRepository;
  readonly sessions: SessionRepository;
  readonly checkpoints: CheckpointRepository;
  readonly delegations: DelegationRepository;
  readonly optimizerEvents: OptimizerEventRepository;
  readonly messages: MessageRepository;
  readonly tasks: TaskRepository;
  readonly catalog: Catalog;
  readonly quota: QuotaEngine;
  readonly secrets: SecretStore;
  readonly providers: ProviderRepository;
  readonly models: ModelCacheRepository;
  readonly providerKeys: ProviderKeyRepository;
  readonly providerKeyEntries: ProviderKeyEntryRepository;
  readonly providerKeyUsage: ProviderKeyUsageDailyRepository;
  readonly cooldowns: CooldownRepository;
  readonly quotaObservations: QuotaObservationRepository;
  readonly handoffs: HandoffRepository;
  readonly logger: Awaited<ReturnType<typeof createLogger>>;
  readonly eventLogs: EventLogRepository;
  readonly deviceId: string;
  emitAppEvent(
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ): void;
  readonly cloud: {
    auth?: CloudAuthService;
    sync?: CloudSyncWorker;
    status: () => Promise<{
      configured: boolean;
      message: string | null;
      auth: CloudAuthStatus;
      storageMode: 'local' | 'cloud';
      ownerEmail: string | null;
      sync: { pending: number; failed: number; lastError: string | null; lastFlush: string | null };
    }>;
    syncNow(): Promise<unknown>;
    migrateLocalKeys(): Promise<KeyMigrationCounts>;
    onChange(listener: () => void): () => void;
  };
  readonly databaseRecoveryMessage?: string;
  dispose(): Promise<void>;
}

const providerKeyFailures = new WeakMap<FerryServices, Map<string, KeyFailure[]>>();

export function recordProviderKeyFailure(
  services: FerryServices,
  entry: ProviderKeyEntry,
  statusCode: number,
  message: string,
): void {
  const saved = services.providers.get(entry.providerId);
  const now = services.clock.now().getTime();
  let histories = providerKeyFailures.get(services);
  if (!histories) {
    histories = new Map();
    providerKeyFailures.set(services, histories);
  }
  const history = (histories.get(entry.id) ?? []).filter(
    (failure) => now - failure.at <= (saved?.autoDisableFailureWindowMinutes ?? 10) * 60_000,
  );
  const current: KeyFailure = { statusCode, message, at: now };
  history.push(current);
  histories.set(entry.id, history);
  let status = entry.status;
  let cooldownUntil: string | null = null;
  if ((statusCode === 401 || statusCode === 403) && saved?.autoDisableEnabled !== false)
    status = 'invalid';
  else if (statusCode === 429) {
    status = 'rate_limited';
    cooldownUntil = new Date(now + 60_000).toISOString();
  } else if (saved?.autoDisableEnabled !== false) {
    const disabledUntil = autoDisableUntil(history.slice(0, -1), current, {
      statusCodes: saved?.autoDisableStatusCodes ?? [],
      keywords: saved?.autoDisableKeywords ?? [],
      failureCount: saved?.autoDisableFailureCount ?? 3,
      windowMs: (saved?.autoDisableFailureWindowMinutes ?? 10) * 60_000,
      disableForMs: (saved?.autoDisableMinutes ?? 60) * 60_000,
    });
    if (disabledUntil !== undefined) {
      status = 'disabled';
      cooldownUntil = new Date(disabledUntil).toISOString();
    }
  }
  services.providerKeyEntries.put({
    ...entry,
    status,
    lastError: redactKnownSecretText(message),
    cooldownUntil,
    updatedAt: new Date(now).toISOString(),
  });
}

export async function createServices({
  dataDir,
  clock,
  random = Math.random,
  env = process.env,
  secrets,
  cloudClientFactory,
}: ServiceOptions): Promise<FerryServices> {
  const home = canonicalizePath(dataDir);
  const paths = getDataPaths({ ...env, FERRY_HOME: home });
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.db, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.checkpoints, { recursive: true }),
  ]);
  const logger = await createLogger({
    logsDir: paths.logs,
    direct: env.FERRY_CLI_PROCESS === 'true' || env.FERRY_LOG_DIRECT === 'true',
  });
  const databasePath = resolve(paths.db, 'ferry.sqlite');
  let db: DatabaseConnection;
  let databaseRecoveryMessage: string | undefined;
  try {
    db = await openDatabase(databasePath);
  } catch (error) {
    if (!isCorruptDatabaseError(error)) throw error;
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${databasePath}.corrupt-${suffix}`;
    await rename(databasePath, backupPath);
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      await rename(sidecar, `${backupPath}${sidecar.slice(databasePath.length)}`).catch(
        () => undefined,
      );
    }
    db = await openDatabase(databasePath);
    const salvagedTables = await salvageReadableTables(db.client, backupPath);
    databaseRecoveryMessage = salvagedTables.length
      ? `Ferry recovered readable database tables (${salvagedTables.join(', ')}). The damaged file was moved to ${backupPath}.`
      : `Ferry found a corrupt database and started a fresh one. The damaged file was moved to ${backupPath}.`;
    logger.error({ err: error, backupPath, salvagedTables }, 'Database recovery completed');
  }
  const catalog = await loadCatalog({ now: clock?.now() ?? new Date() });
  const settings = new SettingsRepository(db.client);
  const eventLogs = new EventLogRepository(db.client);
  const savedDevice = db.client
    .prepare("SELECT value_json FROM settings_kv WHERE key='ferry.device_id'")
    .get() as { value_json?: string } | undefined;
  const deviceId = savedDevice?.value_json
    ? (JSON.parse(savedDevice.value_json) as string)
    : newId('device');
  if (!savedDevice?.value_json)
    db.client
      .prepare('INSERT OR REPLACE INTO settings_kv(key,value_json,updated_at) VALUES(?,?,?)')
      .run('ferry.device_id', JSON.stringify(deviceId), new Date().toISOString());
  const savedSettings = settings.get('global') as
    { storageMode?: string; captureContent?: boolean } | undefined;
  const cloudMode = savedSettings?.storageMode === 'cloud';
  const cloudConfig = loadCloudConfig({ env, ferryHome: home });
  const cloudConfigured = cloudMode && isCloudConfigured(cloudConfig);
  const outbox = cloudConfigured ? new OutboxRepository(db.client) : undefined;
  const localAdapter = createStorageAdapter({ client: db.client, mode: 'local' });
  const cloudRuntime =
    cloudConfigured && outbox
      ? createCloudRuntime({
          config: cloudConfig,
          outbox,
          ...(cloudClientFactory ? { clientFactory: cloudClientFactory } : {}),
          captureContent: () => {
            const latest = settings.get('global') as { captureContent?: boolean } | undefined;
            return resolveCaptureContent({
              storageMode: 'cloud',
              captureContent: latest?.captureContent,
            });
          },
          applyHydratedRows: (table, rows) => applyHydratedRows(table, rows, localAdapter, outbox),
          onProviderKeyEvent: (event) => {
            logger.info(
              {
                event: 'provider_key.' + event.kind,
                providerId: event.providerId,
                keyId: event.keyId,
              },
              'Cloud provider key event',
            );
          },
          workerOptions: {
            onError: (message) => {
              emitAppEvent('sync.error', { error: message }, 'error');
              notifyCloudStatus();
            },
            onFlushed: (at) => {
              emitAppEvent('sync.flushed', { at });
              notifyCloudStatus();
            },
          },
        })
      : undefined;
  const emitAppEvent = (
    event: string,
    data: Record<string, unknown> = {},
    level: 'info' | 'warn' | 'error' = 'info',
  ) => {
    const id = newId('evt');
    const record = {
      id,
      ts: new Date().toISOString(),
      device_id: deviceId,
      level,
      source: 'app',
      event,
      app_version: env.FERRY_RELEASE_VERSION ?? '0.9.0',
      message: null,
      data: { ...data, event_id: id },
    };
    eventLogs.put(record);
    logger[level]({ event, ...data }, event);
    if (cloudConfigured && outbox)
      outbox.enqueue({
        opId: `logs:${id}`,
        target: 'logs',
        op: 'insert',
        payload: {
          ts: record.ts,
          device_id: deviceId,
          level,
          source: 'app',
          event,
          app_version: record.app_version,
          message: null,
          data: record.data,
        },
      });
  };
  if (cloudConfigured && outbox)
    outbox.enqueue({
      opId: `devices:${deviceId}`,
      target: 'devices',
      op: 'upsert',
      payload: {
        id: deviceId,
        name: env.COMPUTERNAME ?? env.HOSTNAME ?? 'Ferry device',
        client_kind: env.FERRY_CLI_PROCESS === 'true' ? 'cli' : 'desktop',
        platform: process.platform,
        app_version: env.FERRY_RELEASE_VERSION ?? '0.9.0',
        last_seen_at: new Date().toISOString(),
      },
    });
  const adapter = cloudRuntime
    ? createStorageAdapter({ client: db.client, mode: 'cloud', mirror: cloudRuntime.mirror })
    : localAdapter;
  const cloudAuth = cloudRuntime?.auth;
  const cloudSync = cloudRuntime?.sync;
  const cloudStatusListeners = new Set<() => void>();
  const notifyCloudStatus = () => {
    for (const listener of cloudStatusListeners) listener();
  };
  cloudAuth?.onChange(notifyCloudStatus);
  if (cloudRuntime) await cloudRuntime.initialize();
  if (cloudMode && !cloudConfigured)
    logger.warn(
      'Cloud storage is selected but Supabase is not configured; using local storage until configuration is available',
    );
  const {
    messages,
    tasks,
    checkpoints,
    delegations,
    optimizerEvents,
    providers,
    models,
    providerKeys,
    providerKeyEntries,
    providerKeyUsage,
  } = adapter;
  const legacyKeyEntryTime = (clock ?? { now: () => new Date() }).now().toISOString();
  for (const { provider } of catalog.providers) {
    if (providerKeyEntries.list(provider).length) continue;
    const legacyKey = providerKeys.get(provider);
    if (!legacyKey) continue;
    // A legacy key is not in Vault yet, so seed local metadata without queuing a remote UPDATE.
    localAdapter.providerKeyEntries.put({
      id: `${provider}:1`,
      providerId: provider,
      keyId: '1',
      label: 'Key 1',
      position: 0,
      enabled: true,
      status: 'ok',
      lastError: null,
      cooldownUntil: null,
      keyringRef: legacyKey.keyringRef,
      createdAt: legacyKey.createdAt,
      updatedAt: legacyKeyEntryTime,
    });
  }
  const { cooldowns, quotaObservations, handoffs } = adapter;
  const quota = new QuotaEngine({
    catalog,
    eligibleProviders: () =>
      catalog.providers.flatMap(({ provider, key_required }) => {
        const entries = providerKeyEntries.list(provider);
        const hasKey = entries.length
          ? entries.some(
              (entry) =>
                entry.enabled &&
                entry.status !== 'invalid' &&
                (entry.status !== 'disabled' ||
                  Boolean(
                    entry.cooldownUntil &&
                    Date.parse(entry.cooldownUntil) <=
                      (clock ?? { now: () => new Date() }).now().getTime(),
                  )) &&
                (entry.status !== 'rate_limited' ||
                  !entry.cooldownUntil ||
                  Date.parse(entry.cooldownUntil) <=
                    (clock ?? { now: () => new Date() }).now().getTime()),
            )
          : Boolean(providerKeys.get(provider));
        const saved = providers.get(provider);
        const enabled = saved?.enabled ?? (hasKey || key_required === false);
        return enabled && !saved?.freeTierUnsupported && (hasKey || key_required === false)
          ? [provider]
          : [];
      }),
    requestRepository: adapter.requests,
    observationRepository: quotaObservations,
    now: () => (clock ?? { now: () => new Date() }).now(),
    onError: (error) => {
      logger.error({ err: error }, 'Failed to emit quota.updated');
    },
  });
  const testKeyringNamespace = env.FERRY_TEST_KEYRING_NAMESPACE;
  const safeMemoryKeyring =
    env.NODE_ENV === 'test' ||
    (env.NODE_ENV !== 'production' &&
      env.FERRY_DEV_MODE === 'true' &&
      env.FERRY_PACKAGED !== 'true');
  if (testKeyringNamespace && !safeMemoryKeyring)
    logger.warn('Ignoring FERRY_TEST_KEYRING_NAMESPACE outside test or unpackaged dev mode');
  const localSecretStore =
    secrets ??
    (testKeyringNamespace && safeMemoryKeyring
      ? new MemorySecretStore(testKeyringNamespace)
      : new KeyringSecretStore(env.FERRY_KEYRING_SERVICE ?? 'Ferry'));
  const secretStore = cloudRuntime?.secrets ?? localSecretStore;
  const stopOpenRouterPolling = quota.startOpenRouterPolling(
    async () => {
      const key = await secretStore.get('openrouter');
      if (!key) return;
      const configured = env.FERRY_PROVIDER_BASE_URL_OPENROUTER ?? 'https://openrouter.ai/api/v1';
      const origin = configured.replace(/\/$/, '').replace(/\/api\/v1$/, '');
      const response = await fetch(`${origin}/api/v1/key`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) return;
      const body: unknown = await response.json().catch(() => ({}));
      const observedAt = (clock ?? { now: () => new Date() }).now().toISOString();
      for (const window of parseOpenRouterKey(body, new Date(observedAt))) {
        const observation = QuotaObservationSchema.safeParse({
          id: newId('quota'),
          providerId: 'openrouter',
          windowId:
            window.windowId === 'free-model-requests-day'
              ? 'openrouter:provider:*:requests:fixed_daily'
              : window.windowId,
          metric: window.windowId === 'credits' ? 'credits' : 'requests',
          ...(window.limit === null || window.remaining === null
            ? {}
            : { value: Math.max(0, window.limit - window.remaining) }),
          limit: window.limit,
          remaining: window.remaining,
          resetAt: window.resetAt,
          source: 'endpoint',
          observedAt,
        });
        if (observation.success) quota.observe(observation.data);
      }
    },
    () => Boolean(providerKeys.get('openrouter')),
  );
  let disposed = false;
  return {
    dataDir: home,
    paths,
    clock: clock ?? { now: () => new Date() },
    random,
    env,
    db,
    settings: adapter.settings,
    workspaces: adapter.workspaces,
    sessions: adapter.sessions,
    checkpoints,
    delegations,
    optimizerEvents,
    messages,
    tasks,
    catalog,
    quota,
    secrets: secretStore,
    providers,
    models,
    providerKeys,
    providerKeyEntries,
    providerKeyUsage,
    cooldowns,
    quotaObservations,
    handoffs,
    logger,
    eventLogs,
    deviceId,
    emitAppEvent,
    cloud: {
      ...(cloudAuth ? { auth: cloudAuth } : {}),
      ...(cloudSync ? { sync: cloudSync } : {}),
      async status() {
        const auth = cloudAuth
          ? await cloudAuth
              .getStatus()
              .catch(() => ({ signedIn: false, email: null, userId: null, isOwner: false }))
          : { signedIn: false, email: null, userId: null, isOwner: false };
        const currentMode =
          (settings.get('global') as { storageMode?: string } | undefined)?.storageMode === 'cloud'
            ? ('cloud' as const)
            : ('local' as const);
        return {
          configured: isCloudConfigured(cloudConfig),
          storageMode: currentMode,
          ownerEmail: cloudConfig.ownerEmail ?? null,
          message: !isCloudConfigured(cloudConfig)
            ? 'Supabase cloud configuration is missing'
            : currentMode === 'cloud' && !cloudAuth
              ? 'Restart Ferry to initialize cloud mode.'
              : auth.signedIn
                ? null
                : 'Cloud sign-in required',
          auth,
          sync: cloudSync
            ? { ...cloudSync.status(), failed: outbox?.counts().failedPermanent ?? 0 }
            : {
                pending: outbox?.counts().pending ?? 0,
                failed: outbox?.counts().failedPermanent ?? 0,
                lastError: null,
                lastFlush: null,
              },
        };
      },
      async syncNow() {
        if (!cloudSync) throw new Error('Restart Ferry in configured cloud mode to sync.');
        return cloudSync.flush({ timeoutMs: 20_000 });
      },
      async migrateLocalKeys() {
        if (!cloudRuntime)
          throw new Error('Restart Ferry in configured cloud mode to migrate keys.');
        return await migrateLocalKeysToVault({
          local: localSecretStore,
          vault: cloudRuntime.secrets,
          entries: catalog.providers
            .flatMap(({ provider }) => providerKeyEntries.list(provider))
            .flatMap((entry) =>
              entry.keyringRef
                ? [{ id: entry.id, providerId: entry.providerId, keyringRef: entry.keyringRef }]
                : [],
            ),
        });
      },
      onChange(listener) {
        cloudStatusListeners.add(listener);
        return () => {
          cloudStatusListeners.delete(listener);
        };
      },
    },
    ...(databaseRecoveryMessage ? { databaseRecoveryMessage } : {}),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await stopOpenRouterPolling();
      if (cloudRuntime) await cloudRuntime.dispose();
      if (localSecretStore instanceof MemorySecretStore) localSecretStore.clear();
      await logger.close();
      quota.dispose();
      db.close();
    },
  };
}

export function hasUsableProviderKey(services: FerryServices, providerId: string): boolean {
  const entries = services.providerKeyEntries.list(providerId);
  if (!entries.length) return Boolean(services.providerKeys.get(providerId));
  const now = services.clock.now().getTime();
  return entries.some(
    (entry) =>
      entry.enabled &&
      entry.status !== 'invalid' &&
      (entry.status !== 'disabled' ||
        Boolean(entry.cooldownUntil && Date.parse(entry.cooldownUntil) <= now)) &&
      (entry.status !== 'rate_limited' ||
        !entry.cooldownUntil ||
        Date.parse(entry.cooldownUntil) <= now),
  );
}

function isCorruptDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  return /SQLITE_(?:CORRUPT|NOTADB)/.test(code) || /SQLITE_(?:CORRUPT|NOTADB)/i.test(message);
}
