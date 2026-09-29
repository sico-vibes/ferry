import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizePath } from '@ferry/shared/node-paths';
import { createClient, createClientAsync } from '../src/client.js';

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

describe('CLI client engine selection', () => {
  it('starts the local RPC core and keeps settings between client lifecycles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ferry-cli-local-'));
    dataDirs.push(dataDir);
    const first = await createClientAsync({ engine: 'local', dataDir });
    try {
      const info = await first.system.info();
      expect(info.mock).toBe(false);
      expect(canonicalizePath(info.dataDir ?? '')).toBe(canonicalizePath(dataDir));
      await first.settings.update({ theme: 'light' });
    } finally {
      await first.dispose?.();
    }

    const second = await createClientAsync({ engine: 'local', dataDir });
    try {
      expect((await second.settings.get()).theme).toBe('light');
    } finally {
      await second.dispose?.();
    }
  }, 30_000);

  it('keeps the synchronous factory scoped to the mock engine', () => {
    expect(() => createClient({ engine: 'local' })).toThrow('createClientAsync');
  });
});
