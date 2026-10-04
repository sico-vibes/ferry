import { execFileSync, spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageCliRuntime } from '../../apps/cli/scripts/stage-runtime.mjs';
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
  const cliDistribution = resolve(repositoryRoot, 'apps/cli/dist');
  await stageCliRuntime({ sourceDirectory: cliDistribution, targetDirectory: cliOutput });

  for (const args of [
    [resolve(packageRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
    [
      resolve(packageRoot, 'node_modules', 'electron-builder', 'cli.js'),
      '--win',
      'nsis',
      'portable',
      '--publish',
      'never',
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
