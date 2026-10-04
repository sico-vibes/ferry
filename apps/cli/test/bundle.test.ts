import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stageCliRuntime } from '../scripts/stage-runtime.mjs';

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = join(cliDirectory, 'dist', 'ferry.js');

describe('built CLI bundle', () => {
  it('keeps the ESM bundle free of CommonJS directory globals', () => {
    const bundle = readFileSync(cliEntry, 'utf8');
    expect(bundle).not.toMatch(/\b__(?:dirname|filename)\b/);
  });

  it('runs version and status under plain Node with isolated data', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ferry-cli-node-bundle-'));
    const env: NodeJS.ProcessEnv = { ...process.env, FERRY_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const version = spawnSync(process.execPath, [cliEntry, '--version'], {
        encoding: 'utf8',
        timeout: 30_000,
        env,
      });
      expect(version.error).toBeUndefined();
      expect(version.status, `${version.stderr}\n${version.stdout}`).toBe(0);
      expect(version.stdout).toMatch(/\d+\.\d+\.\d+/);

      const status = spawnSync(process.execPath, [cliEntry, 'status', '--json'], {
        encoding: 'utf8',
        timeout: 30_000,
        env,
      });
      expect(status.error).toBeUndefined();
      expect(status.status, `${status.stderr}\n${status.stdout}`).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ engine: 'local' });
    } finally {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);

  it('runs a packaged resources/cli copy outside the monorepo', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'ferry-cli-staged-bundle-'));
    const resourcesCli = join(temporaryRoot, 'resources', 'cli');
    const dataDir = join(temporaryRoot, 'profile', 'engine');
    const env: NodeJS.ProcessEnv = { ...process.env, FERRY_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      await stageCliRuntime({
        sourceDirectory: join(cliDirectory, 'dist'),
        targetDirectory: resourcesCli,
      });
      const stagedEntry = join(resourcesCli, 'ferry.js');
      const version = spawnSync(process.execPath, [stagedEntry, '--version'], {
        encoding: 'utf8',
        timeout: 30_000,
        env,
      });
      expect(version.error).toBeUndefined();
      expect(version.status, `${version.stderr}\n${version.stdout}`).toBe(0);
      expect(version.stdout).toMatch(/\d+\.\d+\.\d+/);

      const status = spawnSync(
        process.execPath,
        [stagedEntry, 'status', '--json', '--engine', 'mock'],
        { encoding: 'utf8', timeout: 30_000, env },
      );
      expect(status.error).toBeUndefined();
      expect(status.status, `${status.stderr}\n${status.stdout}`).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ engine: 'mock' });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);

  it('runs the local providers list command from the bundled ESM entry', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ferry-cli-bundle-'));
    try {
      const result = spawnSync(
        process.execPath,
        [cliEntry, '--engine=local', '--data-dir', dataDir, 'providers', 'list', '--json'],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'gemini' })]),
      );
      expect(result.stderr).not.toContain('Dynamic require of "process" is not supported');
    } finally {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);
});
