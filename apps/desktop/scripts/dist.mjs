import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { electronBuilderConfigForVersion, packageManifestWithVersion } from './release-config.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const env = {
  ...process.env,
  FERRY_COMMIT: (
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim()
  ).slice(0, 12),
  ELECTRON_BUILDER_CACHE: resolve(repositoryRoot, '.dev', 'eb-cache'),
};

async function run(command, args, cwd) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32' && command === 'pnpm',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult(code ?? 1));
  });
  if (result !== 0) throw new Error(`${command} exited with ${String(result)}`);
}

async function buildDistribution() {
  await run('pnpm', ['--filter', '@ferry/cli', 'build'], repositoryRoot);
  const cliOutput = resolve(packageRoot, 'out', 'cli');
  await mkdir(cliOutput, { recursive: true });
  await cp(resolve(repositoryRoot, 'apps/cli/dist'), cliOutput, { recursive: true });
  await cp(resolve(repositoryRoot, 'apps/cli/package.json'), resolve(cliOutput, 'package.json'));
  await writeFile(
    resolve(cliOutput, 'ferry.cmd'),
    '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\..\\Ferry.exe" "%~dp0ferry.js" %*\r\n',
    'utf8',
  );
  const runtimeDependencies = [
    '@napi-rs/keyring',
    '@napi-rs/keyring-win32-x64-msvc',
    '@vscode/ripgrep',
    '@vscode/ripgrep-win32-x64',
    'better-sqlite3',
    'citty',
    'cli-highlight',
    'ink',
    'ink-spinner',
    'ink-text-input',
    'marked',
    'node-pty',
    'pino',
    'pino-roll',
    'react',
    'zod',
  ];
  const cliNodeModules = resolve(cliOutput, 'node_modules');
  await rm(cliNodeModules, { recursive: true, force: true });
  const packageSources = [resolve(repositoryRoot, 'apps/cli'), packageRoot];
  const pendingPackages = runtimeDependencies.map((name) => ({
    name,
    from: packageSources,
    destination: resolve(cliNodeModules, ...name.split('/')),
    required: true,
  }));
  const stagedDestinations = new Set();

  while (pendingPackages.length > 0) {
    const { name, from, destination, required } = pendingPackages.shift();
    if (stagedDestinations.has(destination)) continue;

    let entry;
    const roots = Array.isArray(from) ? from : [from];
    try {
      for (const root of roots) {
        try {
          entry = createRequire(join(root, 'package.json')).resolve(name);
          break;
        } catch {
          // The dependency may be linked only from the desktop package.
        }
      }
      if (!entry) {
        const modulePaths = roots.flatMap(
          (root) => createRequire(join(root, 'package.json')).resolve.paths(name) ?? [],
        );
        for (const modulePath of modulePaths) {
          try {
            entry = resolve(modulePath, ...name.split('/'));
            entry = await realpath(entry);
            break;
          } catch {
            // Some native packages contain assets but no Node entry point.
          }
        }
      }
      if (!entry) throw new Error('No package resolution root found');
    } catch (error) {
      if (!required) continue;
      throw new Error(`Missing bundled CLI runtime dependency ${name} (from ${from})`, {
        cause: error,
      });
    }

    let source;
    try {
      source = await realpath(entry);
    } catch (error) {
      if (!required) continue;
      throw error;
    }
    let packageRootPath;
    let manifest;
    while (!packageRootPath) {
      const manifestPath = join(source, 'package.json');
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (manifest.name === name) {
          packageRootPath = source;
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      const parent = dirname(source);
      if (parent === source) throw new Error(`Could not locate package root for ${name}`);
      source = parent;
    }

    const topLevelDestination = resolve(cliNodeModules, ...name.split('/'));
    let finalDestination = destination;
    if (destination !== topLevelDestination) {
      try {
        const topLevelManifest = JSON.parse(
          await readFile(join(topLevelDestination, 'package.json'), 'utf8'),
        );
        if (topLevelManifest.version === manifest.version) finalDestination = topLevelDestination;
      } catch {
        finalDestination = topLevelDestination;
      }
    }
    if (!stagedDestinations.has(finalDestination)) {
      await mkdir(dirname(finalDestination), { recursive: true });
      await cp(packageRootPath, finalDestination, { recursive: true, dereference: true });
      stagedDestinations.add(finalDestination);
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      pendingPackages.push({
        name: dependency,
        from: packageRootPath,
        destination: resolve(finalDestination, 'node_modules', ...dependency.split('/')),
        required: true,
      });
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      pendingPackages.push({
        name: dependency,
        from: packageRootPath,
        destination: resolve(finalDestination, 'node_modules', ...dependency.split('/')),
        required: false,
      });
  }

  for (const args of [
    [resolve(packageRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
    [
      resolve(packageRoot, 'node_modules', 'electron-builder', 'cli.js'),
      '--win',
      'nsis',
      'portable',
    ],
  ]) {
    await run(process.execPath, args, packageRoot);
  }

  if (process.env.FERRY_SKIP_SMOKE !== '1') {
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [resolve(packageRoot, 'scripts', 'smoke-packaged.mjs')],
        {
          cwd: packageRoot,
          env,
          stdio: 'inherit',
        },
      );
      child.once('error', reject);
      child.once('exit', (code) => resolveResult(code ?? 1));
    });
    if (result !== 0) throw new Error(`Packaged smoke exited with ${String(result)}`);
  }
}

// Electron downloads its binary lazily (no postinstall), so a fresh checkout has
// no node_modules/electron/dist until something runs it. electron-builder's
// electronDist needs it, so fetch it up front (a no-op when already installed).
execFileSync(process.execPath, [resolve(packageRoot, 'node_modules', 'electron', 'install.js')], {
  cwd: packageRoot,
  env,
  stdio: 'inherit',
});

const releaseVersion = process.env.FERRY_RELEASE_VERSION;
const packageFiles = [
  resolve(repositoryRoot, 'apps', 'cli', 'package.json'),
  resolve(packageRoot, 'package.json'),
];
const restoreFiles = new Map();
try {
  if (releaseVersion) {
    for (const path of packageFiles) restoreFiles.set(path, await readFile(path, 'utf8'));
    for (const [path, original] of restoreFiles) {
      const manifest = JSON.parse(original);
      await writeFile(
        path,
        `${JSON.stringify(packageManifestWithVersion(manifest, releaseVersion), null, 2)}\n`,
        'utf8',
      );
    }
    const builderConfigPath = resolve(packageRoot, 'electron-builder.yml');
    const builderConfig = await readFile(builderConfigPath, 'utf8');
    restoreFiles.set(builderConfigPath, builderConfig);
    await writeFile(
      builderConfigPath,
      electronBuilderConfigForVersion(builderConfig, releaseVersion),
      'utf8',
    );
  }
  await buildDistribution();
} finally {
  for (const [path, contents] of restoreFiles) await writeFile(path, contents, 'utf8');
}
