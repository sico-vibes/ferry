import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRpcFerryClient, RpcError } from '@ferry/client';
import { MemorySecretStore, KeyringSecretStore } from '@ferry/secrets';
import { ProviderIdSchema } from '@ferry/shared';
import { FakeOpenAIServer, type FakeResponse } from '@ferry/testkit';
import { CoreHost, createMemoryTransportPair } from '../src/index.js';
import { createServices } from '../src/services.js';
import { domainRegistrars } from '../src/domains/index.js';

const root = await mkdtemp(join(tmpdir(), 'ferry-qa-w2-core-'));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const KEY = 'sk-ferryqaw2-4f9a1c2b3d4e5f60718293a4b5c6d7e8';
const PREFIX = KEY.slice(0, -4);

type Services = Awaited<ReturnType<typeof createServices>>;

async function startServer(responses: FakeResponse[] = []): Promise<FakeOpenAIServer> {
  return new FakeOpenAIServer({
    responses,
    responseHeaders: {
      'x-ratelimit-limit-requests': '20',
      'x-ratelimit-remaining-requests': '13',
      'x-ratelimit-reset-requests': '3600',
    },
  }).start();
}

async function makeHarness(fake: FakeOpenAIServer) {
  const dataDir = join(root, `h-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
  const services = await createServices({
    dataDir,
    env: {
      ...process.env,
      FERRY_TEST_KEYRING_NAMESPACE: 'qa-w2',
      FERRY_PROVIDER_BASE_URL_OPENAI: `${fake.baseUrl}/v1`,
    },
  });
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = new CoreHost({ dataDir, transport: coreTransport, services });
  for (const register of domainRegistrars) register(host, services);
  const events: { method: string; payload: unknown }[] = [];
  host.onEvent((method, payload) => events.push({ method, payload }));
  await host.start();
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 20_000 });
  await rpc.hello;
  return {
    services,
    host,
    rpc,
    events,
    async close() {
      rpc.close();
      await host.stop();
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof RpcError ? error : null;
  }
}

function scanTables(services: Services): string {
  const db = services.db.client;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  return tables
    .map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all()))
    .join('\n');
}

async function readDirectoryFiles(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(directory, entry.name), 'utf8')),
  );
  return files.join('\n');
}

function flushLogger(services: Services): Promise<void> {
  return new Promise<void>((done, fail) => {
    services.logger.flush((error) => {
      if (error) fail(error);
      else done();
    });
  });
}

function expectNoKey(text: string, label: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(PREFIX);
}

describe('QA-w2 core: key safety across every surface', () => {
  it('never exposes a set key through RPC, events, DB, logs, or system.info', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    try {
      const connected = await h.rpc.providers.setKey(ProviderIdSchema.parse('openai'), KEY);
      expect(JSON.stringify(connected)).not.toContain(PREFIX);
      expect(await h.services.secrets.get('openai')).toBe(KEY);

      h.services.logger.info({
        message: `using ${KEY}`,
        apiKey: KEY,
        nested: { authorization: `Bearer ${KEY}` },
      });
      await flushLogger(h.services);

      const probeResult = await h.rpc.providers.probe(ProviderIdSchema.parse('openai'));
      expect(probeResult.ok).toBe(true);
      const providers = await h.rpc.providers.list();
      const models = await h.rpc.models.list();
      const capacity = await h.rpc.quota.capacity();
      const history = await h.rpc.quota.history(30);
      const info = await h.rpc.system.info();
      await new Promise((resolve) => setTimeout(resolve, 350));

      expectNoKey(
        JSON.stringify({ connected, probeResult, providers, models, capacity, history, info }),
        'rpc surfaces',
      );
      expectNoKey(JSON.stringify(h.events), 'events');
      expectNoKey(scanTables(h.services), 'sqlite tables');
      expectNoKey(await readDirectoryFiles(h.services.paths.db), 'sqlite files');
      expectNoKey(await readDirectoryFiles(h.services.paths.logs), 'log files');
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 40_000);

  it('removeKey really deletes the secret and stops further provider calls', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    try {
      await h.rpc.providers.setKey(ProviderIdSchema.parse('openai'), KEY);
      const requestsBeforeRemoval = fake.requests.length;
      const removed = await h.rpc.providers.removeKey(ProviderIdSchema.parse('openai'));
      expect(removed).toMatchObject({ keyStatus: 'missing', enabled: false });
      expect(await h.services.secrets.get('openai')).toBeUndefined();
      expect(await h.services.secrets.has('openai')).toBe(false);
      expect(h.services.providerKeys.get('openai')).toBeUndefined();
      expectNoKey(scanTables(h.services), 'sqlite after removal');

      const afterRemove = await h.rpc.providers.probe(ProviderIdSchema.parse('openai'));
      expect(afterRemove).toMatchObject({ ok: false, keyValid: false, errorKind: 'auth' });
      expect(fake.requests.length).toBe(requestsBeforeRemoval);
      expect(JSON.stringify(afterRemove)).not.toContain(PREFIX);
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);

  it('rejects unknown providers and empty/whitespace/oversized keys without storing anything', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    try {
      const unknown = await rejection(
        h.rpc.providers.setKey(ProviderIdSchema.parse('not-a-provider'), KEY),
      );
      expect(unknown).toBeInstanceOf(RpcError);
      expect(unknown?.kind).toBe('not_found');
      expect(JSON.stringify(unknown?.message)).not.toContain(PREFIX);
      expect(await h.services.secrets.get('not-a-provider')).toBeUndefined();
      expect(h.services.providerKeys.get('not-a-provider')).toBeUndefined();

      await h.rpc.providers.setKey(ProviderIdSchema.parse('openai'), KEY);
      for (const bad of ['', '   ', '\t\n', 'x'.repeat(4097)]) {
        const error = await rejection(
          h.rpc.providers.setKey(ProviderIdSchema.parse('openai'), bad),
        );
        expect(error?.kind, JSON.stringify(bad.slice(0, 8))).toBe('validation');
      }
      expect(await h.services.secrets.get('openai')).toBe(KEY);
      expectNoKey(scanTables(h.services), 'sqlite after rejected keys');
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);

  it('stores a unicode key intact while keeping it out of responses', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    const unicodeKey = `ключ-雪-😀-${KEY}`;
    try {
      const result = await h.rpc.providers.setKey(ProviderIdSchema.parse('openai'), unicodeKey);
      expect(await h.services.secrets.get('openai')).toBe(unicodeKey);
      expect(JSON.stringify(result)).not.toContain(unicodeKey.slice(0, -4));
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);

  it('keeps the secret and its key reference consistent under concurrent mutations', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    const id = ProviderIdSchema.parse('openai');
    try {
      for (let round = 0; round < 5; round += 1) {
        await h.rpc.providers.setKey(id, `${KEY}-round-${String(round)}`);
        await Promise.all([
          h.rpc.providers.removeKey(id),
          h.rpc.providers.setKey(id, `${KEY}-re-${String(round)}`),
          h.rpc.providers.setEnabled(id, true),
        ]);
        const secretPresent = (await h.services.secrets.get('openai')) !== undefined;
        const referencePresent = h.services.providerKeys.get('openai') !== undefined;
        expect(secretPresent, `round ${String(round)} secret/reference`).toBe(referencePresent);
        if (referencePresent) {
          expect(h.services.providers.get('openai')?.keyStatus).not.toBe('missing');
        }
      }
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);

  it('reports a 429 as a cooldown while keeping the key out of the provider event', async () => {
    const fake = await startServer([{ status: 429, body: { error: { message: 'rate limited' } } }]);
    const h = await makeHarness(fake);
    try {
      await h.rpc.providers.setKey(ProviderIdSchema.parse('openai'), KEY);
      const first = await h.rpc.providers.probe(ProviderIdSchema.parse('openai'));
      expect(first).toMatchObject({ ok: false, errorKind: 'rate_limit' });
      const provider = (await h.rpc.providers.list()).find((entry) => entry.id === 'openai');
      expect(provider?.health).toBe('cooldown');
      expect(provider?.cooldownUntil).not.toBeNull();
      expectNoKey(JSON.stringify({ first, provider, events: h.events }), '429 surfaces');
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);

  it('returns an empty history with zero data and rejects out-of-range day counts', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    try {
      expect(await h.rpc.quota.history(7)).toEqual([]);
      expect((await rejection(h.rpc.quota.history(0)))?.kind).toBe('validation');
      expect((await rejection(h.rpc.quota.history(366)))?.kind).toBe('validation');
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);

  it('advertises a probeable model for every catalog API provider', async () => {
    // BUG: the catalog advertises provider "gemini", but the model snapshot keys Google
    // models under "google". gemini therefore has modelCount 0 and providers.probe("gemini")
    // can never succeed -- probe() throws "No catalog model found for gemini", which is
    // mapped to a network error ("Could not reach provider"), masking the real defect.
    const fake = await startServer();
    const h = await makeHarness(fake);
    try {
      const stranded = (await h.rpc.providers.list())
        .filter((provider) => provider.kind === 'api' && provider.modelCount === 0)
        .map((provider) => provider.id);
      expect(stranded).toEqual([]);
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);
});

describe('QA-w2 core: test keyring selection', () => {
  it('uses the in-memory keyring when FERRY_TEST_KEYRING_NAMESPACE is set', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    try {
      expect(h.services.secrets).toBeInstanceOf(MemorySecretStore);
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);

  it('falls back to the OS keyring store when the test namespace is unset or empty', async () => {
    const dataDir = join(root, `default-keyring-${String(Date.now())}`);
    const services = await createServices({
      dataDir,
      env: { ...process.env, FERRY_TEST_KEYRING_NAMESPACE: '' },
    });
    try {
      expect(services.secrets).toBeInstanceOf(KeyringSecretStore);
    } finally {
      await services.dispose();
    }
  }, 30_000);
});

describe('QA OAuth key safety', () => {
  it('keeps OAuth tokens out of RPC results, events, SQLite rows, and logs', async () => {
    const fake = await startServer();
    const h = await makeHarness(fake);
    const access = 'oauth-access-fake-9d12';
    const refresh = 'oauth-refresh-fake-2c83';
    try {
      await h.services.secrets.set(
        'oauth:anthropic',
        JSON.stringify({
          type: 'oauth',
          access,
          refresh,
          expires: Date.now() + 60_000,
        }),
      );
      const providers = await h.rpc.oauth.list();
      expect(await h.rpc.oauth.status('anthropic')).toBe(true);
      expect(JSON.stringify(providers)).not.toContain(access);
      expect(JSON.stringify(providers)).not.toContain(refresh);
      expect(JSON.stringify(h.events)).not.toContain(access);
      expect(JSON.stringify(h.events)).not.toContain(refresh);
      await flushLogger(h.services);
      expect(scanTables(h.services)).not.toContain(access);
      expect(scanTables(h.services)).not.toContain(refresh);
      const logs = await readDirectoryFiles(h.services.paths.logs);
      expect(logs).not.toContain(access);
      expect(logs).not.toContain(refresh);
    } finally {
      await h.close();
      await fake.stop();
    }
  }, 30_000);
});
