import { basename, dirname, join, resolve } from 'node:path';

export interface FerryRuntimePathInput {
  entryFilePath: string;
  execPath: string;
  env: Readonly<Record<string, string | undefined>>;
  resourcesPath?: string | undefined;
  exists: (path: string) => boolean;
}

export interface FerryRuntimePaths {
  catalogDataDirectory: string;
  migrationsDirectory: string;
  nativeModuleAnchor: string;
  nativeModuleDirectories: string[];
}

export function resolveFerryRuntimePaths(input: FerryRuntimePathInput): FerryRuntimePaths {
  const entryFilePath = resolve(input.entryFilePath);
  const entryDirectory = dirname(entryFilePath);
  const resourcesRoots = uniquePaths([
    input.resourcesPath,
    resourcesRootFromAsarEntry(entryFilePath),
    resourcesRootFromCliEntry(entryFilePath),
    input.env.ELECTRON_RUN_AS_NODE === '1'
      ? join(dirname(resolve(input.execPath)), 'resources')
      : undefined,
  ]);
  const appAsarRoots = uniquePaths(
    resourcesRoots.map((resourcesRoot) => join(resourcesRoot, 'app.asar')),
  );
  const workspaceRoots = getAncestors(entryDirectory);

  const catalogCandidates = uniquePaths([
    ...appAsarRoots.map((appAsarRoot) => join(appAsarRoot, 'out', 'data')),
    join(entryDirectory, 'data'),
    join(entryDirectory, '..', 'data'),
    ...workspaceRoots.map((root) => join(root, 'packages', 'catalog', 'data')),
  ]);
  const migrationCandidates = uniquePaths([
    join(entryDirectory, 'migrations'),
    ...appAsarRoots.map((appAsarRoot) => join(appAsarRoot, 'out', 'main', 'migrations')),
    ...appAsarRoots.map((appAsarRoot) =>
      join(dirname(appAsarRoot), 'app.asar.unpacked', 'out', 'main', 'migrations'),
    ),
    join(entryDirectory, '..', 'migrations'),
    ...workspaceRoots.map((root) => join(root, 'packages', 'storage', 'src', 'migrations')),
  ]);
  const nativeAnchorCandidates = uniquePaths([
    ...appAsarRoots.map((appAsarRoot) => join(appAsarRoot, 'out', 'main', 'index.js')),
    entryFilePath,
  ]);
  const nativeDirectoryCandidates = uniquePaths([
    ...appAsarRoots.map((appAsarRoot) => join(appAsarRoot, 'node_modules')),
    ...getAncestors(entryDirectory).map((directory) => join(directory, 'node_modules')),
  ]);

  const existingCatalogDirectories = catalogCandidates.filter(input.exists);
  const existingMigrationDirectories = migrationCandidates.filter(input.exists);
  const existingNativeAnchors = nativeAnchorCandidates.filter(input.exists);
  const nativeModuleDirectories = nativeDirectoryCandidates.filter(input.exists);
  const catalogDataDirectory = existingCatalogDirectories[0];
  const migrationsDirectory = existingMigrationDirectories[0];
  const nativeModuleAnchor = existingNativeAnchors[0];

  if (
    catalogDataDirectory === undefined ||
    migrationsDirectory === undefined ||
    nativeModuleAnchor === undefined ||
    nativeModuleDirectories.length === 0
  )
    throw new Error(
      [
        'Could not resolve Ferry runtime paths. Candidate paths checked:',
        formatCandidates('catalog data directory', catalogCandidates),
        formatCandidates('SQL migrations directory', migrationCandidates),
        formatCandidates('native module anchor', nativeAnchorCandidates),
        formatCandidates('native module directories', nativeDirectoryCandidates),
      ].join('\n'),
    );

  return {
    catalogDataDirectory,
    migrationsDirectory,
    nativeModuleAnchor,
    nativeModuleDirectories,
  };
}

function resourcesRootFromAsarEntry(entryFilePath: string): string | undefined {
  const segments = entryFilePath.split(/[\\/]+/);
  const archiveIndex = segments.findIndex((segment) => segment.toLowerCase() === 'app.asar');
  if (archiveIndex < 1) return undefined;
  const root = segments.slice(0, archiveIndex).join('/');
  return root || undefined;
}

function resourcesRootFromCliEntry(entryFilePath: string): string | undefined {
  const entryDirectory = dirname(entryFilePath);
  if (basename(entryDirectory).toLowerCase() !== 'cli') return undefined;
  const resourcesDirectory = dirname(entryDirectory);
  return basename(resourcesDirectory).toLowerCase() === 'resources'
    ? resourcesDirectory
    : undefined;
}

function getAncestors(directory: string): string[] {
  const ancestors: string[] = [];
  let current: string | undefined = resolve(directory);
  while (current !== undefined) {
    ancestors.push(current);
    const parent = dirname(current);
    current = parent === current ? undefined : parent;
  }
  return ancestors;
}

function uniquePaths(paths: (string | undefined)[]): string[] {
  return [
    ...new Set(
      paths.filter((path): path is string => path !== undefined).map((path) => resolve(path)),
    ),
  ];
}

function formatCandidates(label: string, paths: string[]): string {
  return `${label}:\n${paths.map((path) => `  - ${path}`).join('\n')}`;
}
