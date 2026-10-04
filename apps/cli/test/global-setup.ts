import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCliBundleInputs, latestInputTime } from './bundle-inputs.js';

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDirectory = resolve(cliDirectory, '../..');
const cliEntry = join(cliDirectory, 'dist', 'ferry.js');

export default function setup(): void {
  const entryTime = existsSync(cliEntry) ? statSync(cliEntry).mtimeMs : 0;
  const inputs = deriveCliBundleInputs(rootDirectory).inputs;
  if (entryTime > Math.max(...inputs.map(latestInputTime))) return;

  const require = createRequire(import.meta.url);
  const tsupManifest = require.resolve('tsup/package.json');
  const tsupBin = join(dirname(tsupManifest), 'dist', 'cli-default.js');
  const result = spawnSync(process.execPath, [tsupBin, '--config', 'tsup.config.ts'], {
    cwd: cliDirectory,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(`Building the CLI for QA tests failed:\n${result.stdout}\n${result.stderr}`);
}
