import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { pruneLogFiles } from '../src/log-retention.js';

it('deletes expired rotated log files and preserves active and unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-retention-'));
  try {
    const old = join(root, 'ferry.1.log');
    await writeFile(old, 'Old metadata');
    await utimes(old, new Date('2000-01-01'), new Date('2000-01-01'));
    await writeFile(join(root, 'ferry.2.log'), 'Current metadata');
    await writeFile(join(root, 'README.txt'), 'Preserved');
    expect(await pruneLogFiles(root, new Date(Date.now() - 7 * 86_400_000))).toBe(1);
    expect(await pruneLogFiles(root, new Date(Date.now() - 7 * 86_400_000))).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 30_000);
