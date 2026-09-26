import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = join(cliDirectory, 'dist', 'ferry.js');

describe('built CLI bundle', () => {
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
