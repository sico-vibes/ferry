import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLogger, getDataPaths, type DataPaths } from '@ferry/config';
import { KeyringSecretStore, MemorySecretStore, type SecretStore } from '@ferry/secrets';
import { loadCatalog, type Catalog } from '@ferry/catalog';
import { QuotaEngine } from '@ferry/quota';
import { parseOpenRouterKey } from '@ferry/providers';
import { QuotaObservationSchema, newId } from '@ferry/shared';
import {
  CheckpointRepository,
  ProviderRepository,
  ModelCacheRepository,
  ProviderKeyRepository,
  RequestRepository,
  QuotaObservationRepository,
  CooldownRepository,
  HandoffRepository,
  DelegationRepository,
  MessageRepository,
  TaskRepository,
  OptimizerEventRepository,
  SettingsRepository,
  SessionRepository,
  WorkspaceRepository,
  openDatabase,
  type DatabaseConnection,
} from '@ferry/storage';

export interface FerryClock {
  now(): Date;
}

export interface ServiceOptions {
  dataDir: string;
  clock?: FerryClock;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
}

export interface FerryServices {
  readonly dataDir: string;
  readonly paths: DataPaths;
  readonly clock: FerryClock;
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
  readonly cooldowns: CooldownRepository;
  readonly quotaObservations: QuotaObservationRepository;
  readonly handoffs: HandoffRepository;
  readonly logger: ReturnType<typeof createLogger>;
  readonly databaseRecoveryMessage?: string;
  dispose(): Promise<void>;
}

export async function createServices({
  dataDir,
  clock,
  env = process.env,
  secrets,
}: ServiceOptions): Promise<FerryServices> {
  const home = resolve(dataDir);
  const paths = getDataPaths({ ...env, FERRY_HOME: home });
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.db, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.checkpoints, { recursive: true }),
  ]);
  const logger = createLogger({ logsDir: paths.logs });
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
    databaseRecoveryMessage = `Ferry found a corrupt database and started a fresh one. The damaged file was moved to ${backupPath}.`;
  }
  const catalog = await loadCatalog({ now: clock?.now() ?? new Date() });
  const messages = new MessageRepository(db.client);
  const tasks = new TaskRepository(db.client);
  const checkpoints = new CheckpointRepository(db.client);
  const delegations = new DelegationRepository(db.client);
  const optimizerEvents = new OptimizerEventRepository(db.client);
  const providers = new ProviderRepository(db.client);
  const models = new ModelCacheRepository(db.client);
  const providerKeys = new ProviderKeyRepository(db.client);
  const cooldowns = new CooldownRepository(db.client);
  const quotaObservations = new QuotaObservationRepository(db.client);
  const handoffs = new HandoffRepository(db.client);
  const quota = new QuotaEngine({
    catalog,
    eligibleProviders: () =>
      catalog.providers.flatMap(({ provider, key_required }) => {
        const hasKey = Boolean(providerKeys.get(provider));
        const saved = providers.get(provider);
        const enabled = saved?.enabled ?? hasKey;
        return enabled && (hasKey || key_required === false) ? [provider] : [];
      }),
    requestRepository: new RequestRepository(db.client),
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
  const secretStore =
    secrets ??
    (testKeyringNamespace && safeMemoryKeyring
      ? new MemorySecretStore(testKeyringNamespace)
      : new KeyringSecretStore(env.FERRY_KEYRING_SERVICE ?? 'Ferry'));
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
    env,
    db,
    settings: new SettingsRepository(db.client),
    workspaces: new WorkspaceRepository(db.client),
    sessions: new SessionRepository(db.client),
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
    cooldowns,
    quotaObservations,
    handoffs,
    logger,
    ...(databaseRecoveryMessage ? { databaseRecoveryMessage } : {}),
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopOpenRouterPolling();
      if (secretStore instanceof MemorySecretStore) secretStore.clear();
      await new Promise<void>((done, fail) => {
        logger.flush((error) => {
          if (error) fail(error);
          else done();
        });
      });
      quota.dispose();
      db.close();
    },
  };
}

function isCorruptDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  return /SQLITE_(?:CORRUPT|NOTADB)/.test(code) || /SQLITE_(?:CORRUPT|NOTADB)/i.test(message);
}
