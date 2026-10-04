import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpcFerryClient } from '@ferry/client';
import { ProviderIdSchema } from '@ferry/shared';
import type { Profile } from '@ferry/shared';
import { canonicalizePath } from '@ferry/shared/node-paths';
import { createCoreHost, createMemoryTransportPair } from '@ferry/core';
import { FakeOpenAIServer } from '@ferry/testkit';
import {
  createClient,
  createClientAsync,
  desktopEngineDataDirectory,
  prepareEngineDataDirectory,
  resolveEngineDataDirectory,
  selectLocalCore,
} from '../src/client.js';
import { migrateLegacyEngineData } from '../src/data-directory.js';
import { runCli } from '../src/main.js';

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

describe('CLI client engine selection', () => {
  it('selects an existing channel, reports an owner without one, and ignores stale locks', () => {
    const live = (pid: number) => pid === 42;
    expect(selectLocalCore(undefined, false, live)).toEqual({ kind: 'start' });
    expect(selectLocalCore({ pid: 42 }, true, live)).toEqual({ kind: 'connect', pid: 42 });
    expect(selectLocalCore({ pid: 42 }, false, live)).toEqual({ kind: 'unavailable', pid: 42 });
    expect(selectLocalCore({ pid: 41 }, true, live)).toEqual({ kind: 'start' });
  });

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
    const canonicalDataDir = realpathSync.native(dataDir);
    const host = await createCoreHost({ dataDir });
    try {
      const error = await createClientAsync({ engine: 'local', dataDir }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      const actual = error instanceof Error ? error.message : '';
      const expectedPrefix = `Ferry core PID ${String(process.pid)} owns ${canonicalDataDir}, but its local control channel is unavailable.`;
      expect(process.platform === 'win32' ? actual.toLowerCase() : actual).toContain(
        process.platform === 'win32' ? expectedPrefix.toLowerCase() : expectedPrefix,
      );
      expect(actual).toContain(
        'Update or restart Ferry, or pass --data-dir to use another engine directory.',
      );
    } finally {
      await host.stop();
    }
  }, 30_000);

  it('uses one desktop-style core for CLI status, Gateway, and a streamed session run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-cli-shared-core-'));
    dataDirs.push(root);
    const dataDir = join(root, 'engine');
    const workspacePath = join(root, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const providerId = ProviderIdSchema.parse('openrouter');
    const fake = new FakeOpenAIServer({
      responses: [
        {
          chunks: [
            fakeChunk({ role: 'assistant' }),
            fakeChunk({ content: 'shared core stream' }),
            fakeChunk({}, 'stop'),
          ],
        },
      ],
    });
    await fake.start();
    const [desktopTransport, desktopClientTransport] = createMemoryTransportPair();
    const host = await createCoreHost({
      dataDir,
      transport: desktopTransport,
      localControl: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        FERRY_TEST_KEYRING_NAMESPACE: `ferry-cli-local-control-${String(process.pid)}`,
        FERRY_PROVIDER_BASE_URL_OPENROUTER: `${fake.baseUrl}/openrouter/v1`,
      },
    });
    const services = host.options.services;
    if (!services) throw new Error('Desktop-style core services were not created');
    const desktopClient = createRpcFerryClient(desktopClientTransport);
    await desktopClient.hello;
    let cliClient: Awaited<ReturnType<typeof createClientAsync>> | undefined;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await services.secrets.set(providerId, 'integration-fixture-key');
      services.providerKeys.put({
        id: providerId,
        providerId,
        keyringRef: providerId,
        createdAt: new Date().toISOString(),
      });
      await desktopClient.providers.setEnabled(providerId, true);
      const fixtureModel = services.catalog.models.find(
        (model) =>
          model.providerId === providerId &&
          model.toolCalling &&
          model.free &&
          /:free(?:$|:)/i.test(model.ref),
      );
      if (!fixtureModel) throw new Error('No free tool-capable OpenRouter test model exists');
      services.models.put(providerId, fixtureModel);
      const workspace = await desktopClient.workspaces.open(workspacePath);
      const autoFree = (await desktopClient.profiles.list()).find(
        (profile) => profile.name === 'Auto-Free',
      );
      if (!autoFree) throw new Error('Auto-Free profile is unavailable');
      await desktopClient.profiles.save({
        ...autoFree,
        roles: { ...autoFree.roles, enabled: false },
      });

      await expect(
        runCli(['status', '--json', '--engine', 'local', '--data-dir', dataDir]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        engine: 'local',
        providersConfigured: true,
      });

      await desktopClient.gateway.setSettings({ enabled: false, port: 0, allowLan: false });
      output.mockClear();
      await expect(
        runCli(['gateway', 'start', '--json', '--engine', 'local', '--data-dir', dataDir]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        running: true,
      });

      output.mockClear();
      await expect(
        runCli(['gateway', 'status', '--json', '--engine', 'local', '--data-dir', dataDir]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        running: true,
      });

      output.mockClear();
      await expect(
        runCli([
          'gateway',
          'keys',
          'create',
          'round-trip',
          'auto-free',
          '--rpm',
          '40',
          '--concurrency',
          '2',
          '--tokens-per-min',
          '5000',
          '--tokens-per-day',
          '90000',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      const createdKey = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
        key: { id: string };
        secret: string;
      };
      expect(createdKey.secret).toBeTruthy();
      output.mockClear();
      await expect(
        runCli([
          'gateway',
          'keys',
          'show',
          createdKey.key.id,
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        rateLimit: 40,
        concurrencyLimit: 2,
        tokenLimitPerMinute: 5000,
        tokenLimitPerDay: 90000,
      });
      output.mockClear();
      await expect(
        runCli([
          'gateway',
          'keys',
          'update',
          createdKey.key.id,
          '--rpm',
          '80',
          '--clear',
          'tokens-per-day',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        rateLimit: 80,
        tokenLimitPerDay: null,
      });
      output.mockClear();
      await expect(
        runCli(['gateway', 'keys', 'list', '--json', '--engine', 'local', '--data-dir', dataDir]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: createdKey.key.id })]),
      );

      const stdinIterator = vi.spyOn(process.stdin, Symbol.asyncIterator);
      const addProviderKey = async (secret: string, label: string) => {
        let sent = false;
        stdinIterator.mockReturnValue({
          next: () =>
            Promise.resolve(
              sent
                ? { done: true, value: undefined }
                : ((sent = true), { done: false, value: Buffer.from(secret) }),
            ),
          return: () => Promise.resolve({ done: true, value: undefined }),
          [Symbol.asyncDispose]: () => Promise.resolve(),
          [Symbol.asyncIterator]() {
            return this;
          },
        });
        output.mockClear();
        await expect(
          runCli([
            'providers',
            'keys',
            'openrouter',
            'add',
            '--stdin',
            '--label',
            label,
            '--json',
            '--engine',
            'local',
            '--data-dir',
            dataDir,
          ]),
        ).resolves.toBe(0);
        return JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
          id: string;
        };
      };
      await addProviderKey('provider-core-secret-1111', 'core-one');
      const providerKeyTwo = await addProviderKey('provider-core-secret-2222', 'core-two');
      output.mockClear();
      await expect(
        runCli([
          'providers',
          'keys',
          'openrouter',
          'move',
          providerKeyTwo.id,
          '1',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);

      const affinityBase = (await desktopClient.profiles.list()).find(
        (profile) => profile.name === 'Auto-Free',
      );
      if (!affinityBase) throw new Error('Auto-Free profile is unavailable');
      const affinityProfile = await desktopClient.profiles.save({
        ...affinityBase,
        id: 'profile_cli_affinity' as Profile['id'],
        name: 'CLI affinity',
        builtin: false,
      });
      output.mockClear();
      await expect(
        runCli([
          'profiles',
          'affinity',
          affinityProfile.name,
          'strict',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toEqual({
        profile: affinityProfile.name,
        affinityMode: 'strict',
      });
      output.mockClear();
      await expect(
        runCli([
          'profiles',
          'affinity',
          affinityProfile.id,
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        affinityMode: 'strict',
      });
      await runCli([
        'providers',
        'keys',
        'openrouter',
        'disable',
        providerKeyTwo.id,
        '--json',
        '--engine',
        'local',
        '--data-dir',
        dataDir,
      ]);
      output.mockClear();
      await expect(
        runCli([
          'providers',
          'keys',
          'openrouter',
          'list',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: providerKeyTwo.id, enabled: false }),
        ]),
      );
      await expect(
        runCli([
          'providers',
          'keys',
          'openrouter',
          'remove',
          providerKeyTwo.id,
          '--yes',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      stdinIterator.mockRestore();

      await expect(
        runCli([
          'providers',
          'routing',
          'openrouter',
          '--priority',
          '9',
          '--weight',
          '3',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      output.mockClear();
      await expect(
        runCli([
          'providers',
          'routing',
          'openrouter',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        priority: 9,
        weight: 3,
      });
      await expect(
        runCli([
          'models',
          'map',
          'set',
          'logical-core',
          'openrouter',
          'openai/test-model',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      output.mockClear();
      await expect(
        runCli(['models', 'map', 'list', '--json', '--engine', 'local', '--data-dir', dataDir]),
      ).resolves.toBe(0);
      const mappings = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
        mappings: unknown[];
      };
      expect(mappings.mappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ logicalName: 'logical-core', upstreamId: 'openai/test-model' }),
        ]),
      );
      await expect(
        runCli([
          'providers',
          'overrides',
          'openrouter',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      await expect(
        runCli([
          'gateway',
          'keys',
          'revoke',
          createdKey.key.id,
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
        ]),
      ).resolves.toBe(0);
      output.mockClear();
      await expect(
        runCli(['gateway', 'stop', '--json', '--engine', 'local', '--data-dir', dataDir]),
      ).resolves.toBe(0);
      expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        running: false,
        stopped: true,
      });

      output.mockClear();
      await expect(
        runCli([
          'run',
          'stream through the desktop core',
          '--profile',
          autoFree.name,
          '--max-steps',
          '2',
          '--json',
          '--engine',
          'local',
          '--data-dir',
          dataDir,
          '--cwd',
          workspace.path,
        ]),
      ).resolves.toBe(0);
      const runOutput = output.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(runOutput).toContain('shared core stream');
      expect(fake.requests.some((request) => request.url.endsWith('/chat/completions'))).toBe(true);
      cliClient = await createClientAsync({ engine: 'local', dataDir });
      expect((await cliClient.system.info()).mock).toBe(false);
    } finally {
      output.mockRestore();
      await cliClient?.dispose?.();
      desktopClient.close();
      await fake.stop();
      await host.stop();
    }
  }, 60_000);
});

function fakeChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl_local_control',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
