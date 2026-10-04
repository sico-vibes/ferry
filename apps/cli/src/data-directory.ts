import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { dirname, join } from 'node:path';

export function desktopEngineDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32')
    return paths.join(
      env.APPDATA ?? paths.join(homeDirectory, 'AppData', 'Roaming'),
      'Ferry',
      'engine',
    );
  if (platform === 'darwin')
    return paths.join(homeDirectory, 'Library', 'Application Support', 'Ferry', 'engine');
  return paths.join(env.XDG_CONFIG_HOME ?? paths.join(homeDirectory, '.config'), 'Ferry', 'engine');
}

export function resolveEngineDataDirectory(
  explicitDataDirectory?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  return (
    explicitDataDirectory ??
    nonEmpty(env.FERRY_DATA_DIR) ??
    desktopEngineDataDirectory(env, platform, homeDirectory)
  );
}

export async function prepareEngineDataDirectory(
  explicitDataDirectory?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): Promise<string> {
  const dataDirectory = resolveEngineDataDirectory(
    explicitDataDirectory,
    env,
    platform,
    homeDirectory,
  );
  if (explicitDataDirectory || nonEmpty(env.FERRY_DATA_DIR)) return dataDirectory;

  const legacyDataDirectory = join(homeDirectory, '.ferry');
  const migration = await migrateLegacyEngineData(legacyDataDirectory, dataDirectory);
  if (migration === 'migrated')
    process.stderr.write(
      `Ferry copied CLI data from ${legacyDataDirectory} to ${dataDirectory}; the original files were kept.\n`,
    );
  else if (migration === 'both-exist')
    process.stderr.write(
      `Ferry is using ${dataDirectory}; legacy CLI data remains at ${legacyDataDirectory}.\n`,
    );
  return dataDirectory;
}

export type LegacyMigrationResult = 'none' | 'migrated' | 'both-exist' | 'core-active';

export async function migrateLegacyEngineData(
  legacyDataDirectory: string,
  desktopDataDirectory: string,
): Promise<LegacyMigrationResult> {
  if (legacyDataDirectory === desktopDataDirectory) return 'none';
  const legacyDatabase = join(legacyDataDirectory, 'db', 'ferry.sqlite');
  const desktopDatabase = join(desktopDataDirectory, 'db', 'ferry.sqlite');
  if (!(await fileExists(legacyDatabase))) return 'none';
  if (await fileExists(desktopDatabase)) return 'both-exist';

  await assertCoreStopped(legacyDataDirectory);
  if (await coreIsRunning(desktopDataDirectory)) return 'core-active';
  await mkdir(dirname(desktopDataDirectory), { recursive: true });
  const stagingDirectory = join(
    dirname(desktopDataDirectory),
    `.ferry-engine-migration-${String(process.pid)}-${randomUUID()}`,
  );
  try {
    await copyEngineFiles(legacyDataDirectory, stagingDirectory);
    await assertCoreStopped(desktopDataDirectory);
    if (await directoryExists(desktopDataDirectory)) {
      if (await fileExists(desktopDatabase)) return 'both-exist';
      await copyEngineFiles(stagingDirectory, desktopDataDirectory);
    } else {
      await rename(stagingDirectory, desktopDataDirectory);
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  if (!(await fileExists(desktopDatabase)))
    throw new Error(`Ferry data migration did not copy ${desktopDatabase}.`);
  try {
    await writeFile(
      join(legacyDataDirectory, '.ferry-data-copied-to-desktop-engine'),
      `Ferry copied this engine data to ${desktopDataDirectory}. The original files remain here.\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  return 'migrated';
}

async function copyEngineFiles(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<void> {
  await mkdir(destinationDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (isCoreTransientFile(entry.name)) continue;
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isDirectory()) {
      await copyEngineFiles(sourcePath, destinationPath);
    } else if (sourceStats.isFile()) {
      try {
        await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    } else if (sourceStats.isSymbolicLink()) {
      try {
        await symlink(await readlink(sourcePath), destinationPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
  }
}

function isCoreTransientFile(name: string): boolean {
  return (
    name === 'core.lock' ||
    name.startsWith('core.lock.') ||
    name === 'core.endpoint.json' ||
    name.startsWith('core.endpoint.json.') ||
    name === 'core.sock'
  );
}

async function assertCoreStopped(dataDirectory: string): Promise<void> {
  if (await coreIsRunning(dataDirectory))
    throw new Error(
      `Cannot copy Ferry data while a core is running for ${dataDirectory}. Stop Ferry and retry.`,
    );
}

async function coreIsRunning(dataDirectory: string): Promise<boolean> {
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(join(dataDirectory, 'core.lock'), 'utf8')) as unknown;
  } catch {
    return false;
  }
  if (
    typeof lock !== 'object' ||
    lock === null ||
    !('pid' in lock) ||
    typeof lock.pid !== 'number' ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 1
  )
    return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}
