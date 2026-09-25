import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLogger, getDataPaths, type DataPaths } from '@ferry/config';
import { KeyringSecretStore, type SecretStore } from '@ferry/secrets';
import { loadCatalog, type Catalog } from '@ferry/catalog';
import { QuotaEngine } from '@ferry/quota';
import {
  CheckpointRepository,
  QuotaObservationRepository,
  RequestRepository,
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
  readonly logger: ReturnType<typeof createLogger>;
  dispose(): Promise<void>;
}

export async function createServices({
  dataDir,
  clock,
  env = process.env,
}: ServiceOptions): Promise<FerryServices> {
  const home = resolve(dataDir);
  const paths = getDataPaths({ ...env, FERRY_HOME: home });
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.db, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.checkpoints, { recursive: true }),
  ]);
  const db = await openDatabase(resolve(paths.db, 'ferry.sqlite'));
  const catalog = await loadCatalog(clock ? { now: clock.now() } : {});
  const messages = new MessageRepository(db.client);
  const tasks = new TaskRepository(db.client);
  const checkpoints = new CheckpointRepository(db.client);
  const delegations = new DelegationRepository(db.client);
  const optimizerEvents = new OptimizerEventRepository(db.client);
  const quota = new QuotaEngine({
    catalog,
    requestRepository: new RequestRepository(db.client),
    observationRepository: new QuotaObservationRepository(db.client),
    now: () => (clock ?? { now: () => new Date() }).now(),
  });
  const logger = createLogger({ logsDir: paths.logs });
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
    secrets: new KeyringSecretStore(),
    logger,
    async dispose() {
      if (disposed) return;
      disposed = true;
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
