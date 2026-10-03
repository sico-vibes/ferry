import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizePath } from '@ferry/shared/node-paths';
import { createCoreHost } from '@ferry/core';
import {
  createClient,
  createClientAsync,
  desktopEngineDataDirectory,
  prepareEngineDataDirectory,
  resolveEngineDataDirectory,
} from '../src/client.js';
import { migrateLegacyEngineData } from '../src/data-directory.js';

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

describe('CLI client engine selection', () => {
  it('uses the Electron Ferry user data engine directory on each desktop platform', () => {
    expect(
      desktopEngineDataDirectory(
        { APPDATA: 'C:\\Users\\ferry\\AppData\\Roaming' },
        'win32',
        'C:\\Users\\ferry',
      ),
    ).toBe('C:\\Users\\ferry\\AppData\\Roaming\\Ferry\\engine');
    expect(desktopEngineDataDirectory({}, 'darwin', '/Users/ferry')).toBe(
      '/Users/ferry/Library/Application Support/Ferry/engine',
    );
    expect(
      desktopEngineDataDirectory({ XDG_CONFIG_HOME: '/tmp/ferry-config' }, 'linux', '/home/ferry'),
    ).toBe('/tmp/ferry-config/Ferry/engine');
  });

  it('lets --data-dir and environment overrides win over the desktop default', () => {
    expect(
      resolveEngineDataDirectory(
        'D:/explicit',
        { FERRY_DATA_DIR: 'D:/env', FERRY_HOME: 'D:/home' },
        'win32',
      ),
    ).toBe('D:/explicit');
    expect(resolveEngineDataDirectory(undefined, { FERRY_DATA_DIR: 'D:/env' }, 'win32')).toBe(
      'D:/env',
    );
  });

  it('copies a CLI-only engine directory and leaves the legacy files in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-cli-migration-'));
    dataDirs.push(root);
    const legacyDataDir = join(root, 'legacy');
    const desktopDataDir = join(root, 'Ferry', 'engine');
    await mkdir(join(legacyDataDir, 'db'), { recursive: true });
    await mkdir(join(legacyDataDir, 'logs'), { recursive: true });
    await writeFile(join(legacyDataDir, 'db', 'ferry.sqlite'), 'database', 'utf8');
    await writeFile(join(legacyDataDir, 'db', 'ferry.sqlite-wal'), 'wal', 'utf8');
    await writeFile(join(legacyDataDir, 'db', 'ferry.sqlite-shm'), 'shm', 'utf8');
    await writeFile(join(legacyDataDir, 'logs', 'ferry.log'), 'log', 'utf8');

    await expect(migrateLegacyEngineData(legacyDataDir, desktopDataDir)).resolves.toBe('migrated');
    for (const [relativePath, content] of [
      ['db/ferry.sqlite', 'database'],
      ['db/ferry.sqlite-wal', 'wal'],
      ['db/ferry.sqlite-shm', 'shm'],
      ['logs/ferry.log', 'log'],
    ] as const) {
      await expect(readFile(join(desktopDataDir, relativePath), 'utf8')).resolves.toBe(content);
      await expect(readFile(join(legacyDataDir, relativePath), 'utf8')).resolves.toBe(content);
    }
    await expect(
      readFile(join(legacyDataDir, '.ferry-data-copied-to-desktop-engine'), 'utf8'),
    ).resolves.toContain(desktopDataDir);
  }, 30_000);

  it('keeps the desktop database and reports a legacy database when both exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-cli-both-databases-'));
    dataDirs.push(root);
    const legacyDataDir = join(root, 'legacy');
    const desktopDataDir = join(root, 'Ferry', 'engine');
    await mkdir(join(legacyDataDir, 'db'), { recursive: true });
    await mkdir(join(desktopDataDir, 'db'), { recursive: true });
    await writeFile(join(legacyDataDir, 'db', 'ferry.sqlite'), 'legacy', 'utf8');
    await writeFile(join(desktopDataDir, 'db', 'ferry.sqlite'), 'desktop', 'utf8');

    await expect(migrateLegacyEngineData(legacyDataDir, desktopDataDir)).resolves.toBe(
      'both-exist',
    );
    await expect(readFile(join(desktopDataDir, 'db', 'ferry.sqlite'), 'utf8')).resolves.toBe(
      'desktop',
    );
    await expect(readFile(join(legacyDataDir, 'db', 'ferry.sqlite'), 'utf8')).resolves.toBe(
      'legacy',
    );
  }, 30_000);

  it('prints one notice naming the legacy path when both default databases exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-cli-both-notice-'));
    dataDirs.push(root);
    const legacyDataDir = join(root, '.ferry');
    const appDataDir = join(root, 'app-data');
    const env =
      process.platform === 'win32' ? { APPDATA: appDataDir } : { XDG_CONFIG_HOME: appDataDir };
    const desktopDataDir = desktopEngineDataDirectory(env, process.platform, root);
    await mkdir(join(legacyDataDir, 'db'), { recursive: true });
    await mkdir(join(desktopDataDir, 'db'), { recursive: true });
    await writeFile(join(legacyDataDir, 'db', 'ferry.sqlite'), 'legacy', 'utf8');
    await writeFile(join(desktopDataDir, 'db', 'ferry.sqlite'), 'desktop', 'utf8');
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(
        prepareEngineDataDirectory(undefined, env, process.platform, root),
      ).resolves.toBe(desktopDataDir);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]?.[0]).toBe(
        `Ferry is using ${desktopDataDir}; legacy CLI data remains at ${legacyDataDir}.\n`,
      );
    } finally {
      write.mockRestore();
    }
  }, 30_000);

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
  }, 60_000);

  it('keeps the synchronous factory scoped to the mock engine', () => {
    expect(() => createClient({ engine: 'local' })).toThrow('createClientAsync');
  });

  it('fails clearly instead of starting a second local core on an owned database', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ferry-cli-owned-core-'));
    dataDirs.push(dataDir);
    const host = await createCoreHost({ dataDir });
    try {
      await expect(createClientAsync({ engine: 'local', dataDir })).rejects.toThrow(
        'A Ferry core already owns',
      );
    } finally {
      await host.stop();
    }
  }, 30_000);
});
