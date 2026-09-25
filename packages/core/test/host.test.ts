import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createMockFerryClient,
  createHybridClient,
  createRpcFerryClient,
  createStdioRpcTransport,
  createWebSocketRpcTransport,
} from '@ferry/client';
import {
  FERRY_PROTOCOL,
  JsonRpcRequestSchema,
  SessionIdSchema,
  SettingsSchema,
  WorkspaceSchema,
} from '@ferry/shared';
import { ShadowCheckpoints, WorkspaceJail } from '@ferry/workspace';
import {
  CoreHost,
  CoreLockError,
  createCoreHost,
  createMemoryTransportPair,
  createStdioTransport,
  mapError,
} from '../src/index.js';
import { runFerryClientContract } from '../../client/src/testing/contract.js';
import { createFakeClock } from '../../client/src/mock/clock.js';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-core-test-'));
vi.setConfig({ testTimeout: 30_000 });
let activeHost: CoreHost | undefined;

async function makeStdioHarness() {
  await activeHost?.stop();
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const clientTransport = createStdioRpcTransport(clientOutput, clientInput);
  const host = new CoreHost({
    dataDir: join(dataDir, String(Date.now())),
    transport: createStdioTransport(clientInput, clientOutput),
  });
  activeHost = host;
  const fake = createFakeClock(new Date('2026-09-23T21:47:00.000Z'));
  const mock = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
  host.registerDomain(
    'providers',
    mock.providers as unknown as Record<string, (...params: unknown[]) => unknown>,
  );
  await host.start();
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
  await rpc.hello;
  return {
    client: createHybridClient(mock, rpc, ['providers']),
    advance: (ms: number) => {
      fake.advance(ms);
      return Promise.resolve();
    },
  };
}

runFerryClientContract('HybridClient contract over core stdio RPC harness', makeStdioHarness);

async function makeRealDomainsHarness() {
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({
    dataDir: join(dataDir, 'real-domain-contract'),
    transport: coreTransport,
  });
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
  await rpc.hello;
  const mock = createMockFerryClient({ behavior: 'test' });
  return {
    client: createHybridClient(mock, rpc, ['settings', 'workspaces', 'checkpoints']),
    cleanup: async () => {
      rpc.close();
      await host.stop();
    },
  };
}

runFerryClientContract('In-process Core RPC selected domains', makeRealDomainsHarness, {
  domains: ['settings', 'workspaces', 'checkpoints', 'system'],
});

afterAll(async () => {
  await activeHost?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('core host dispatcher and lifecycle', () => {
  it('runs the real settings, workspaces, checkpoints and system domains over loopback RPC', async () => {
    const path = join(dataDir, 'composition');
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const host = await createCoreHost({ dataDir: path, transport: coreTransport });
    const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
    try {
      const hello = await rpc.hello;
      expect(hello.realDomains).toEqual(['settings', 'workspaces', 'checkpoints']);
      await mkdir(join(path, 'workspace'), { recursive: true });
      const opened = await rpc.workspaces.open(join(path, 'workspace'));
      WorkspaceSchema.parse(opened);
      expect((await rpc.workspaces.list()).map((workspace) => workspace.id)).toContain(opened.id);
      SettingsSchema.parse(await rpc.settings.update({ theme: 'light' }));
      const sessionId = SessionIdSchema.parse('contract_session');
      const projectFile = join(opened.path, 'project.txt');
      await writeFile(projectFile, 'before checkpoint\n', 'utf8');
      const shadow = new ShadowCheckpoints(new WorkspaceJail(opened.path), path);
      const checkpointId = await shadow.snapshot('Before change');
      await writeFile(projectFile, 'after checkpoint\n', 'utf8');
      expect(
        await rpc.checkpoints.diff(checkpointId as import('@ferry/shared').CheckpointId),
      ).toContain('before checkpoint');
      expect((await rpc.checkpoints.list(sessionId)).map((checkpoint) => checkpoint.id)).toContain(
        checkpointId,
      );
      await rpc.checkpoints.restore(checkpointId as import('@ferry/shared').CheckpointId);
      expect(await readFile(projectFile, 'utf8')).toBe('before checkpoint\n');
      expect(await rpc.system.info()).toMatchObject({
        dataDir: path,
        realDomains: hello.realDomains,
      });
    } finally {
      rpc.close();
      await host.stop();
    }

    const [nextCoreTransport, nextClientTransport] = createMemoryTransportPair();
    const nextHost = await createCoreHost({ dataDir: path, transport: nextCoreTransport });
    const nextClient = createRpcFerryClient(nextClientTransport, { timeoutMs: 15_000 });
    try {
      expect((await nextClient.settings.get()).theme).toBe('light');
    } finally {
      nextClient.close();
      await nextHost.stop();
    }
  }, 60_000);

  it('distinguishes unknown methods from known unimplemented methods', async () => {
    const host = new CoreHost({ dataDir: join(dataDir, 'dispatch') });
    const unimplemented = await host
      .dispatch({ jsonrpc: '2.0', id: 1, method: 'sessions.send', params: [] })
      .catch((error: unknown) => error);
    expect((unimplemented as Error).message).toContain('not implemented');
    const unknown = await host
      .dispatch({ jsonrpc: '2.0', id: 2, method: 'sessions.noSuchMethod', params: [] })
      .catch((error: unknown) => error);
    expect((unknown as Error).message).toContain('Unknown method');
    expect(
      JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'sessions.send' }).success,
    ).toBe(true);
  });

  it('reports contract methods, enforces one writer, and releases the lock on stop', async () => {
    const path = join(dataDir, 'lock');
    const first = new CoreHost({ dataDir: path });
    await first.start();
    await expect(new CoreHost({ dataDir: path }).start()).rejects.toBeInstanceOf(CoreLockError);
    await first.stop();
    await expect(new CoreHost({ dataDir: path }).start()).resolves.toBeUndefined();
  });

  it('maps domain errors to the stable taxonomy envelope', () => {
    expect(mapError(Object.assign(new Error('missing key'), { code: -32040 }))).toMatchObject({
      code: -32040,
      data: { kind: 'domain_error' },
    });
  });

  it('rejects an incompatible hello protocol', async () => {
    const host = new CoreHost({ dataDir: join(dataDir, 'hello') });
    await expect(
      host.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'system.hello',
        params: [{ protocol: 'ferry/99', capabilities: [] }],
      }),
    ).rejects.toThrow(FERRY_PROTOCOL);
  });

  it('starts loopback WebSocket RPC only when the feature flag is enabled', async () => {
    const host = new CoreHost({
      dataDir: join(dataDir, 'websocket'),
      websocketEnabled: true,
    });
    await host.start();
    try {
      const endpoint = host.websocket;
      if (!endpoint) throw new Error('WebSocket server did not start');
      expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rpc\?token=/);
      expect(endpoint.token).toHaveLength(64);
      const rpc = createRpcFerryClient(createWebSocketRpcTransport(endpoint.url));
      await expect(rpc.hello).resolves.toMatchObject({ protocol: 'ferry/1', realDomains: [] });
      expect((await rpc.system.info()).mock).toBe(false);
      rpc.close();
    } finally {
      await host.stop();
    }
  });
});
