import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupRotatedLogs } from '../src/services.js';

const directories: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      ),
  );
});

describe('log retention', () => {
  it('removes only rotated Ferry logs older than the configured cutoff', async () => {
    const logsDir = await mkdtemp(join(tmpdir(), 'ferry-retention-'));
    directories.push(logsDir);
    const oldCutoff = new Date('2025-01-01T00:00:00.000Z');
    const oldLog = join(logsDir, 'ferry.log.1');
    const activeLog = join(logsDir, 'ferry.log');
    const freshLog = join(logsDir, 'ferry.log.2');
    await Promise.all([
      writeFile(oldLog, 'old'),
      writeFile(activeLog, 'active'),
      writeFile(freshLog, 'fresh'),
    ]);
    await utimes(
      oldLog,
      new Date('2024-01-01T00:00:00.000Z'),
      new Date('2024-01-01T00:00:00.000Z'),
    );

    await expect(cleanupRotatedLogs(logsDir, oldCutoff)).resolves.toBe(1);
    await expect(readdir(logsDir)).resolves.toEqual(
      expect.arrayContaining(['ferry.log', 'ferry.log.2']),
    );
    await expect(readFile(activeLog, 'utf8')).resolves.toBe('active');
  });
});
