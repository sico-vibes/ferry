import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDirectory = resolve(cliDirectory, '../..');
const cliEntry = join(cliDirectory, 'dist', 'ferry.js');
const inputs = [
  join(cliDirectory, 'src'),
  join(cliDirectory, 'tsup.config.ts'),
  join(cliDirectory, 'tsconfig.json'),
  join(cliDirectory, 'package.json'),
  join(rootDirectory, 'packages', 'client', 'src'),
  join(rootDirectory, 'packages', 'delegate', 'src'),
  join(rootDirectory, 'packages', 'shared', 'src'),
];

function latestInputTime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.mtimeMs;
  return readdirSync(path).reduce(
    (latest, name) => Math.max(latest, latestInputTime(join(path, name))),
    stat.mtimeMs,
  );
}

export default function setup(): void {
  const entryTime = existsSync(cliEntry) ? statSync(cliEntry).mtimeMs : 0;
  if (entryTime >= Math.max(...inputs.map(latestInputTime))) return;

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
