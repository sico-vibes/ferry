import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFerryRuntimePaths } from '../src/electron-paths.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function makeFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'fixture', 'utf8');
}

function resolveFixture(entryFilePath: string, execPath: string, env: Record<string, string>) {
  return resolveFerryRuntimePaths({
    entryFilePath,
    execPath,
    env,
    exists: (path) =>
      roots.some((root) => {
        const suffix = relative(root, path);
        return !suffix.startsWith('..') && !isAbsolute(suffix);
      }) && existsSync(path),
  });
}

describe('Ferry runtime path resolution', () => {
  it('resolves the packaged resources layout with Electron process.resourcesPath absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-packaged-paths-'));
    roots.push(root);
    const appDirectory = join(root, 'Ferry');
    const resources = join(appDirectory, 'resources');
    const appAsar = join(resources, 'app.asar');
    const entryFilePath = join(resources, 'cli', 'ferry.js');
    const execPath = join(appDirectory, 'Ferry.exe');

    // A directory named app.asar models Electron's virtual archive paths.
    await Promise.all([
      makeFile(join(appAsar, 'out', 'data', 'models.snapshot.json')),
      makeFile(join(appAsar, 'out', 'main', 'index.js')),
      makeDirectory(join(appAsar, 'node_modules')),
      makeFile(join(resources, 'cli', 'migrations', '0001_initial.sql')),
      makeFile(join(resources, 'cli', 'node_modules', 'better-sqlite3', 'package.json')),
      makeFile(entryFilePath),
      makeFile(execPath),
    ]);

    const paths = resolveFixture(entryFilePath, execPath, { ELECTRON_RUN_AS_NODE: '1' });

    expect(paths).toEqual({
      catalogDataDirectory: join(appAsar, 'out', 'data'),
      migrationsDirectory: join(resources, 'cli', 'migrations'),
      nativeModuleAnchor: join(appAsar, 'out', 'main', 'index.js'),
      nativeModuleDirectories: [
        join(appAsar, 'node_modules'),
        join(resources, 'cli', 'node_modules'),
      ],
    });
  }, 30_000);

  it('resolves CLI source paths inside a monorepo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-dev-paths-'));
    roots.push(root);
    const entryFilePath = join(root, 'apps', 'cli', 'src', 'ferry.ts');
    const execPath = join(root, 'node.exe');
    const catalogDataDirectory = join(root, 'packages', 'catalog', 'data');
    const migrationsDirectory = join(root, 'packages', 'storage', 'src', 'migrations');
    const cliNodeModules = join(root, 'apps', 'cli', 'node_modules');
    const rootNodeModules = join(root, 'node_modules');
    await Promise.all([
      makeFile(entryFilePath),
      makeFile(join(catalogDataDirectory, 'models.snapshot.json')),
      makeFile(join(migrationsDirectory, '0001_initial.sql')),
      makeDirectory(cliNodeModules),
      makeDirectory(rootNodeModules),
    ]);

    const paths = resolveFixture(entryFilePath, execPath, {});

    expect(paths).toEqual({
      catalogDataDirectory,
      migrationsDirectory,
      nativeModuleAnchor: entryFilePath,
      nativeModuleDirectories: [cliNodeModules, rootNodeModules],
    });
  }, 30_000);

  it('resolves the CLI test bundle and its copied data and migrations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-cli-dist-paths-'));
    roots.push(root);
    const entryFilePath = join(root, 'apps', 'cli', 'dist', 'ferry.js');
    const execPath = join(root, 'node.exe');
    const catalogDataDirectory = join(root, 'apps', 'cli', 'dist', 'data');
    const migrationsDirectory = join(root, 'apps', 'cli', 'dist', 'migrations');
    const cliNodeModules = join(root, 'apps', 'cli', 'node_modules');
    const rootNodeModules = join(root, 'node_modules');
    await Promise.all([
      makeFile(entryFilePath),
      makeFile(join(catalogDataDirectory, 'models.snapshot.json')),
      makeFile(join(migrationsDirectory, '0001_initial.sql')),
      makeDirectory(cliNodeModules),
      makeDirectory(rootNodeModules),
    ]);

    const paths = resolveFixture(entryFilePath, execPath, {});

    expect(paths).toEqual({
      catalogDataDirectory,
      migrationsDirectory,
      nativeModuleAnchor: entryFilePath,
      nativeModuleDirectories: [cliNodeModules, rootNodeModules],
    });
  }, 30_000);

  it('reports each catalog, migration, and native-module candidate on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-missing-paths-'));
    roots.push(root);
    const entryFilePath = join(root, 'Ferry', 'resources', 'cli', 'ferry.js');
    const execPath = join(root, 'Ferry', 'Ferry.exe');
    await makeFile(entryFilePath);

    let failure = '';
    try {
      resolveFixture(entryFilePath, execPath, { ELECTRON_RUN_AS_NODE: '1' });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    for (const candidate of [
      'Candidate paths checked:',
      'catalog data directory:',
      resolve(root, 'Ferry', 'resources', 'app.asar', 'out', 'data'),
      resolve(root, 'Ferry', 'resources', 'cli', 'data'),
      'SQL migrations directory:',
      resolve(root, 'Ferry', 'resources', 'cli', 'migrations'),
      resolve(root, 'packages', 'storage', 'src', 'migrations'),
      'native module anchor:',
      resolve(root, 'Ferry', 'resources', 'app.asar', 'out', 'main', 'index.js'),
      'native module directories:',
      resolve(root, 'Ferry', 'resources', 'app.asar', 'node_modules'),
    ])
      expect(failure).toContain(candidate);
  }, 30_000);
});
