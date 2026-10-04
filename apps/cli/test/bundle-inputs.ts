import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface WorkspacePackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface CliBundleInputs {
  inputs: string[];
  workspacePackages: { name: string; directory: string }[];
}

export function deriveCliBundleInputs(rootDirectory: string): CliBundleInputs {
  const packageDirectories = ['apps', 'packages'].flatMap((workspaceDirectory) => {
    const directory = join(rootDirectory, workspaceDirectory);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .filter((entry) => existsSync(join(entry, 'package.json')));
  });
  const packages = new Map<string, { directory: string; manifest: WorkspacePackageManifest }>();
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ) as WorkspacePackageManifest;
    packages.set(manifest.name, { directory, manifest });
  }

  const cliManifest = JSON.parse(
    readFileSync(join(rootDirectory, 'apps', 'cli', 'package.json'), 'utf8'),
  ) as WorkspacePackageManifest;
  const pending = [cliManifest.name];
  const included = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || included.has(name)) continue;
    const workspacePackage = packages.get(name);
    if (!workspacePackage) continue;
    included.add(name);
    for (const dependency of [
      ...Object.keys(workspacePackage.manifest.dependencies ?? {}),
      ...Object.keys(workspacePackage.manifest.optionalDependencies ?? {}),
      ...Object.keys(workspacePackage.manifest.peerDependencies ?? {}),
    ]) {
      if (packages.has(dependency)) pending.push(dependency);
    }
  }

  const workspacePackages = [...included]
    .map((name) => {
      const workspacePackage = packages.get(name);
      if (!workspacePackage) throw new Error(`Workspace package ${name} disappeared`);
      return { name, directory: workspacePackage.directory };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const cliDirectory = join(rootDirectory, 'apps', 'cli');
  const inputs = [
    join(rootDirectory, 'pnpm-workspace.yaml'),
    join(rootDirectory, 'tsconfig.base.json'),
    join(rootDirectory, 'pnpm-lock.yaml'),
    join(cliDirectory, 'src'),
    join(cliDirectory, 'package.json'),
    join(cliDirectory, 'tsconfig.json'),
    join(cliDirectory, 'tsup.config.ts'),
    join(rootDirectory, 'packages', 'catalog', 'data'),
    join(rootDirectory, 'packages', 'storage', 'scripts', 'copy-migrations.ts'),
    join(rootDirectory, 'packages', 'storage', 'src', 'migrations'),
    ...workspacePackages.flatMap(({ directory }) => [
      join(directory, 'src'),
      join(directory, 'package.json'),
    ]),
  ];
  return { inputs: [...new Set(inputs.map((input) => resolve(input)))], workspacePackages };
}

export function latestInputTime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.mtimeMs;
  return readdirSync(path).reduce(
    (latest, name) => Math.max(latest, latestInputTime(join(path, name))),
    stat.mtimeMs,
  );
}
