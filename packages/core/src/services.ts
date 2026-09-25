import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLogger, getDataPaths, type DataPaths } from '@ferry/config';
import { KeyringSecretStore, type SecretStore } from '@ferry/secrets';
import {
  CheckpointRepository,
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
  readonly secrets: SecretStore;
  readonly logger: ReturnType<typeof createLogger>;
  readonly databaseRecoveryMessage?: string;
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
    checkpoints: new CheckpointRepository(db.client),
    secrets: new KeyringSecretStore(),
    logger,
    ...(databaseRecoveryMessage ? { databaseRecoveryMessage } : {}),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await new Promise<void>((done, fail) => {
        logger.flush((error) => {
          if (error) fail(error);
          else done();
        });
      });
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
