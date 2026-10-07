import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpcFerryClient } from '@ferry/client';
import { FakeOpenAIServer } from '@ferry/testkit';
import { ProviderIdSchema } from '@ferry/shared';
import type { FerrySupabaseClient } from '@ferry/cloud';
import { CoreHost, createMemoryTransportPair } from '../src/index.js';
import { createServices, type FerryServices } from '../src/services.js';
import { domainRegistrars } from '../src/domains/index.js';
import { textTurn, waitFor } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 60_000 });
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

interface QueryResult {
  data: unknown;
  error: null;
}

class MemorySupabase {
  signedIn = false;
  readonly tables = new Map<string, Record<string, unknown>[]>();
  readonly vault = new Map<string, string>();
  readonly authListeners = new Set<() => void>();
  readonly auth = {
    onAuthStateChange: (listener: () => void) => {
      this.authListeners.add(listener);
      return { data: { subscription: { unsubscribe: () => this.authListeners.delete(listener) } } };
    },
    getUser: () =>
      Promise.resolve({
        data: { user: this.signedIn ? { id: 'fake-user', email: 'ferry@example.test' } : null },
        error: null,
      }),
    signInWithPassword: () => {
      this.signedIn = true;
      for (const listener of this.authListeners) listener();
      return Promise.resolve({ error: null });
    },
    signOut: () => {
      this.signedIn = false;
      for (const listener of this.authListeners) listener();
      return Promise.resolve({ error: null });
    },
  };

  schema() {
    return {
      from: (table: string) => new MemoryQuery(this, table),
      rpc: (name: string, params: Record<string, unknown>) => {
        const key = typeof params.p_key_id === 'string' ? params.p_key_id : '';
        if (name === 'set_provider_key') {
          this.vault.set(key, String(params.p_secret));
          return Promise.resolve({ data: null, error: null });
        }
        if (name === 'get_provider_key_secret')
          return Promise.resolve({ data: this.vault.get(key) ?? null, error: null });
        if (name === 'delete_provider_key') {
          this.vault.delete(key);
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  }
}

class MemoryQuery implements PromiseLike<QueryResult> {
  private operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: Record<string, unknown> | Record<string, unknown>[] = {};
  constructor(
    private readonly memory: MemorySupabase,
    private readonly table: string,
  ) {}
  select(): this {
    this.operation = 'select';
    return this;
  }
  eq(): this {
    return this;
  }
  maybeSingle(): Promise<QueryResult> {
    return Promise.resolve({ data: null, error: null });
  }
  insert(payload: Record<string, unknown>): this {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }
  upsert(payload: Record<string, unknown> | Record<string, unknown>[]): this {
    this.operation = 'upsert';
    this.payload = payload;
    return this;
  }
  update(payload: Record<string, unknown>): this {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }
  delete(): this {
    this.operation = 'delete';
    return this;
  }
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const result: QueryResult = { data: this.execute(), error: null };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
  private execute(): unknown {
    const rows = this.memory.tables.get(this.table) ?? [];
    if (this.operation === 'select') return rows;
    if (this.operation === 'delete') return null;
    const inserted = Array.isArray(this.payload) ? this.payload : [this.payload];
    if (this.operation === 'insert' || this.operation === 'upsert') {
      this.memory.tables.set(this.table, [...rows, ...inserted]);
      return null;
    }
    return null;
  }
}

async function startHost(dataDir: string, services: FerryServices) {
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = new CoreHost({ dataDir, transport: coreTransport, services, localControl: false });
  for (const register of domainRegistrars) register(host, services);
  await host.start();
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 60_000 });
  await rpc.hello;
  return { host, rpc };
}

describe('cloud mode restart E2E with fake Supabase', () => {
  it('signs in after restart, syncs chat, uses a Vault key, and keeps local data on sign-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-cloud-restart-e2e-'));
    dirs.push(root);
    const dataDir = join(root, 'data');
    const workspacePath = join(root, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const upstream = await new FakeOpenAIServer({ responses: [textTurn('Cloud reply')] }).start();
    const memory = new MemorySupabase();
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      FERRY_SUPABASE_URL: 'https://example.supabase.co',
      FERRY_SUPABASE_PUBLISHABLE_KEY: 'fake-publishable-key',
      FERRY_PROVIDER_BASE_URL_OPENROUTER: `${upstream.baseUrl}/v1`,
      FERRY_TEST_KEYRING_NAMESPACE: 'cloud-restart-e2e',
    };
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const localServices = await createServices({ dataDir, env });
      first = await startHost(dataDir, localServices);
      await first.rpc.cloud.setStorageMode({ mode: 'cloud' });
      await first.rpc.cloud.setCaptureContent({ value: true });
      expect(await first.rpc.cloud.status()).toMatchObject({
        pendingMode: 'cloud',
        runningMode: 'local',
      });
      first.rpc.close();
      await first.host.stop();
      first = undefined;

      const cloudServices = await createServices({
        dataDir,
        env,
        cloudClientFactory: () => memory as unknown as FerrySupabaseClient,
      });
      second = await startHost(dataDir, cloudServices);
      expect(await second.rpc.cloud.status()).toMatchObject({
        pendingMode: null,
        runningMode: 'cloud',
      });
      await second.rpc.cloud.signIn({ email: 'ferry@example.test', password: 'valid-password' });
      expect(await second.rpc.cloud.status()).toMatchObject({ auth: { signedIn: true } });

      const providerId = ProviderIdSchema.parse('openrouter');
      const model = cloudServices.catalog.models.find(
        (candidate) =>
          candidate.providerId === providerId && candidate.toolCalling && candidate.free,
      );
      if (!model) throw new Error('No free OpenRouter model fixture is available');
      await second.rpc.providers.setEnabled(providerId, true);
      await second.rpc.providers.setKey(providerId, 'fake-vault-provider-key');
      cloudServices.models.put(providerId, model);
      expect(memory.vault.get('openrouter')).toBe('fake-vault-provider-key');

      const workspace = await second.rpc.workspaces.open(workspacePath);
      await second.rpc.workspaces.trust(workspace.id);
      const session = await second.rpc.sessions.create({ workspaceId: workspace.id });
      await second.rpc.models.select(session.id, model.ref);
      await second.rpc.sessions.send(session.id, { text: 'reply using the Vault-backed key' });
      const cloudHost = second;
      await waitFor(async () => {
        const status = (await cloudHost.rpc.sessions.get(session.id)).session.status;
        return status === 'idle' || status === 'error';
      });
      const sessionDetail = await second.rpc.sessions.get(session.id);
      if (sessionDetail.session.status !== 'idle')
        throw new Error(
          JSON.stringify({ session: sessionDetail.session, messages: sessionDetail.messages }),
        );
      expect(upstream.requests[0]?.headers.authorization).toBe('Bearer fake-vault-provider-key');
      await waitFor(() => (memory.tables.get('messages')?.length ?? 0) > 0);
      expect(memory.tables.get('messages')).toEqual(expect.arrayContaining([expect.any(Object)]));

      await second.rpc.cloud.signOut();
      expect((await second.rpc.cloud.status()).auth.signedIn).toBe(false);
      expect(
        cloudServices.messages.list().some((message) => message.sessionId === session.id),
      ).toBe(true);
    } finally {
      first?.rpc.close();
      second?.rpc.close();
      await first?.host.stop();
      await second?.host.stop();
      await upstream.stop();
    }
  }, 60_000);
});
