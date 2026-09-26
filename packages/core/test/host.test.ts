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
  ProviderIdSchema,
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
import { FakeOpenAIServer } from '@ferry/testkit';
import { MemorySecretStore } from '@ferry/secrets';
import { redactSecretText } from '@ferry/config';
import { redactHeaders } from '@ferry/storage';
import { createServices } from '../src/services.js';
import { domainRegistrars } from '../src/domains/index.js';

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
  const stream = new FakeOpenAIServer({
    responses: [
      {
        chunks: [
          {
            id: 'chatcmpl_contract',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl_contract',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake',
            choices: [{ index: 0, delta: { content: 'Contract response' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl_contract',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ],
      },
    ],
  });
  await stream.start();
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({
    dataDir: join(dataDir, 'real-domain-contract'),
    transport: coreTransport,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FERRY_TEST_KEYRING_NAMESPACE: 'ferry-real-domain-contract',
      FERRY_PROVIDER_BASE_URL_OPENAI: `${stream.baseUrl}/v1`,
    },
  });
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
  await rpc.hello;
  for (const provider of await rpc.providers.list()) {
    await rpc.providers.setKey(provider.id, 'contract-fixture-key');
    await rpc.providers.setEnabled(provider.id, provider.id === 'openai');
  }
  const mock = createMockFerryClient({ behavior: 'test' });
  const workspacePath = join(dataDir, 'real-domain-contract-workspace');
  await mkdir(workspacePath, { recursive: true });
  await rpc.workspaces.open(workspacePath);
  return {
    client: createHybridClient(mock, rpc, [
      'settings',
      'workspaces',
      'checkpoints',
      'providers',
      'models',
      'quota',
      'sessions',
      'approvals',
      'profiles',
      'skills',
      'mcp',
      'optimizer',
      'delegation',
    ]),
    cleanup: async () => {
      rpc.close();
      await host.stop();
      await stream.stop();
    },
  };
}

runFerryClientContract('In-process Core RPC selected domains', makeRealDomainsHarness, {
  domains: [
    'settings',
    'workspaces',
    'checkpoints',
    'providers',
    'models',
    'quota',
    'sessions',
    'approvals',
    'profiles',
    'skills',
    'mcp',
    'optimizer',
    'delegation',
    'system',
  ],
});

afterAll(async () => {
  await activeHost?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('core host dispatcher and lifecycle', () => {
  it('runs the real W1 and W3 domains over loopback RPC', async () => {
    const path = join(dataDir, 'composition');
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const host = await createCoreHost({ dataDir: path, transport: coreTransport });
    const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
    try {
      const hello = await rpc.hello;
      expect(hello.realDomains).toEqual([
        'settings',
        'workspaces',
        'checkpoints',
        'providers',
        'oauth',
        'models',
        'quota',
        'sessions',
        'approvals',
        'profiles',
        'skills',
        'mcp',
        'optimizer',
        'delegation',
      ]);
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

  it('redacts exact stored secrets from mapped error details', async () => {
    const secrets = new MemorySecretStore('map-error');
    const key = 'opaque-value-without-provider-prefix-7192';
    await secrets.set('openai', key);
    const error = Object.assign(new Error('failed'), { code: -32040, details: { note: key } });
    expect(JSON.stringify(mapError(error))).not.toContain(key);
    expect(redactSecretText(`log text ${key}`)).not.toContain(key);
    expect(redactHeaders({ note: `stored header text ${key}` })).not.toContain(key);
    await secrets.delete('openai');
  });

  it('ignores the test keyring namespace in production mode', async () => {
    const services = await createServices({
      dataDir: join(dataDir, 'production-keyring-guard'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        FERRY_DEV_MODE: 'true',
        FERRY_TEST_KEYRING_NAMESPACE: 'must-ignore',
      },
    });
    try {
      expect(services.secrets).not.toBeInstanceOf(MemorySecretStore);
    } finally {
      await services.dispose();
    }
  });

  it('keeps every active limits provider backed by at least one catalog model', async () => {
    const services = await createServices({
      dataDir: join(dataDir, 'limits-model-coverage'),
      env: { ...process.env, NODE_ENV: 'test', FERRY_TEST_KEYRING_NAMESPACE: 'limits-coverage' },
    });
    try {
      const missing = services.catalog.providers
        .filter((provider) => !provider.dead)
        .filter(
          (provider) =>
            !services.catalog.models.some((model) => model.providerId === provider.provider),
        )
        .map((provider) => provider.provider);
      expect(missing).toEqual([]);
    } finally {
      await services.dispose();
    }
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

describe('provider, model and quota RPC integration', () => {
  it('keeps keys out of RPC output, reads fake rate limits, and reports 429 cooldowns', async () => {
    const fake = await new FakeOpenAIServer({
      responseHeaders: {
        'x-ratelimit-limit-requests': '20',
        'x-ratelimit-remaining-requests': '13',
        'x-ratelimit-reset-requests': '3600',
      },
    }).start();
    const path = join(dataDir, 'provider-quota-rpc');
    const services = await createServices({
      dataDir: path,
      env: {
        ...process.env,
        FERRY_PROVIDER_BASE_URL_OPENAI: `${fake.baseUrl}/v1`,
      },
      secrets: new MemorySecretStore(),
    });
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const host = new CoreHost({ dataDir: path, transport: coreTransport, services });
    for (const register of domainRegistrars) register(host, services);
    const emitted: unknown[] = [];
    host.onEvent((_method, payload) => emitted.push(payload));
    await host.start();
    const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 5000 });
    try {
      const secret = 'fake-key-never-a-real-secret';
      const providerId = ProviderIdSchema.parse('openai');
      const connected = await rpc.providers.setKey(providerId, secret);
      expect(connected.keyStatus).toBe('unchecked');
      expect(JSON.stringify(connected)).not.toContain(secret);
      expect(await rpc.models.list(providerId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ ref: 'openai/gpt-4o-mini' })]),
      );

      const probeResult = await rpc.providers.probe(providerId).catch((error: unknown) => {
        const requests = fake.requests.map(({ method, url }) => ({ method, url }));
        throw new Error(
          `Provider probe RPC failed: ${String(error)}; fake requests=${JSON.stringify(requests)}`,
        );
      });
      expect(probeResult).toMatchObject({ ok: true, keyValid: true });
      expect(await rpc.models.list(providerId)).not.toHaveLength(0);
      expect(probeResult.windows[0]).toMatchObject({ limit: 20, remaining: 13 });
      const capacity = await rpc.quota.capacity();
      expect(capacity.perProvider.find((item) => item.providerId === 'openai')).toMatchObject({
        percent: 65,
      });
      expect(await rpc.quota.history(14)).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerId: 'openai', requests: 7 })]),
      );
      expect(JSON.stringify({ probeResult, capacity, emitted })).not.toContain(secret);
      const persisted = JSON.stringify({
        providers: services.providers.list(),
        keyReferences: services.providerKeys.get('openai'),
        quota: services.quotaObservations.list(),
      });
      expect(persisted).not.toContain(secret);

      fake.options.responses = [
        {
          status: 429,
          headers: {
            'retry-after': '30',
            'x-ratelimit-limit-requests': '20',
            'x-ratelimit-remaining-requests': '0',
            'x-ratelimit-reset-requests': '30',
          },
        },
      ];
      const limited = await rpc.providers.probe(providerId);
      expect(limited).toMatchObject({ ok: false, errorKind: 'rate_limit' });
      const provider = (await rpc.providers.list()).find((item) => item.id === 'openai');
      expect(provider).toMatchObject({ health: 'cooldown' });
      expect(provider?.cooldownUntil).not.toBeNull();
      expect(JSON.stringify({ limited, provider, emitted })).not.toContain(secret);
    } finally {
      rpc.close();
      await host.stop();
      await fake.stop();
    }
  }, 30_000);
});
