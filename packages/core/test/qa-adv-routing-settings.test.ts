import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRpcFerryClient, type RpcFerryClient } from '@ferry/client';
import { DEFAULT_ROUTING_SETTINGS, SettingsSchema } from '@ferry/shared';
import { QuotaLeaseLedger } from '@ferry/quota';
import { CoreHost, createCoreHost, createMemoryTransportPair } from '../src/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-qa-adv-core-'));
vi.setConfig({ testTimeout: 30_000 });
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

interface Harness {
  dir: string;
  host: CoreHost;
  rpc: RpcFerryClient;
  close(): Promise<void>;
}

async function makeCore(name: string, dir = join(dataDir, name)): Promise<Harness> {
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({ dataDir: dir, transport: coreTransport });
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
  await rpc.hello;
  return {
    dir,
    host,
    rpc,
    async close() {
      rpc.close();
      await host.stop();
    },
  };
}

describe('QA adv: routing settings persistence', () => {
  it('persists Advanced routing toggles across a core restart', async () => {
    const first = await makeCore('routing-persist');
    const dir = first.dir;
    await first.rpc.settings.update({
      routing: {
        ...DEFAULT_ROUTING_SETTINGS,
        smartReliability: false,
        rampFloor: 0.42,
        stickyTtlMinutes: 5,
        paceShortLimits: false,
        paceMaxWaitSeconds: 12,
        firstTokenTimeoutSeconds: 18,
      },
    });
    const stored = await first.rpc.settings.get();
    expect(stored.routing).toMatchObject({
      smartReliability: false,
      rampFloor: 0.42,
      stickyTtlMinutes: 5,
      paceShortLimits: false,
      paceMaxWaitSeconds: 12,
      firstTokenTimeoutSeconds: 18,
    });
    await first.close();

    const second = await makeCore('routing-persist', dir);
    try {
      const settings = await second.rpc.settings.get();
      SettingsSchema.parse(settings);
      expect(settings.routing).toMatchObject({
        smartReliability: false,
        rampFloor: 0.42,
        stickyTtlMinutes: 5,
        paceShortLimits: false,
        paceMaxWaitSeconds: 12,
        firstTokenTimeoutSeconds: 18,
      });
      expect(settings.routing.stickySessions).toBe(true);
      expect(settings.routing.gentleQuotaRamp).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('merges nested routing patches instead of replacing them', async () => {
    const core = await makeCore('routing-merge');
    try {
      const before = await core.rpc.settings.get();
      const after = await core.rpc.settings.update({
        routing: { ...before.routing, gentleQuotaRamp: false },
      });
      expect(after.routing.gentleQuotaRamp).toBe(false);
      expect(after.routing.smartReliability).toBe(before.routing.smartReliability);
      await core.rpc.settings.update({
        routing: { ...after.routing, smartReliability: false },
      });
      const partial = await core.rpc.settings.update({
        routing: { ...before.routing, rampStart: 0.5 },
      });
      expect(partial.routing.rampStart).toBe(0.5);
      expect(partial.routing.gentleQuotaRamp).toBe(before.routing.gentleQuotaRamp);
    } finally {
      await core.close();
    }
  });

  it('BUG: a partial routing patch resets unspecified Advanced toggles to defaults', async () => {
    // `SettingsSchema.partial()` leaves `routing` as a full RoutingSettings
    // object whose missing keys are default-filled, so the nested merge
    // `{ ...current.routing, ...patch.routing }` overwrites previously saved
    // toggles with schema defaults.
    const core = await makeCore('routing-partial');
    try {
      const before = await core.rpc.settings.get();
      await core.rpc.settings.update({
        routing: { ...before.routing, smartReliability: false, gentleQuotaRamp: false },
      });
      const after = await core.rpc.settings.update({
        routing: { rampFloor: 0.42 },
      } as never);
      expect(after.routing.smartReliability).toBe(false);
      expect(after.routing.gentleQuotaRamp).toBe(false);
      expect(after.routing.rampFloor).toBe(0.42);
    } finally {
      await core.close();
    }
  });
});

describe('QA adv: quota lease ledger', () => {
  const now = 1_000_000;
  const capacity = { requests: 2 as number | null, tokens: 1_000 as number | null };

  it('never grants more concurrent leases than the pool allows', () => {
    const ledger = new QuotaLeaseLedger();
    const first = ledger.acquire('provider::pool', { requests: 1, tokens: 400 }, capacity, now);
    const second = ledger.acquire('provider::pool', { requests: 1, tokens: 400 }, capacity, now);
    const third = ledger.acquire('provider::pool', { requests: 1, tokens: 400 }, capacity, now);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeUndefined();
    if (!first || !second) throw new Error('expected the first two leases to be granted');
    ledger.release(first.id);
    expect(
      ledger.acquire('provider::pool', { requests: 1, tokens: 400 }, capacity, now),
    ).toBeDefined();
    expect(
      ledger.acquire('other::pool', { requests: 1, tokens: 400 }, capacity, now),
    ).toBeDefined();
  });

  it('caps request-only pools and expires leaked leases by TTL', () => {
    const ledger = new QuotaLeaseLedger();
    const requestOnly = { requests: 5 as number | null, tokens: null };
    let granted = 0;
    for (let index = 0; index < 20; index += 1) {
      if (ledger.acquire('req::pool', { requests: 1, tokens: 100 }, requestOnly, now)) granted += 1;
    }
    expect(granted).toBe(5);

    const ttlPool = { requests: 1 as number | null, tokens: 10 as number | null };
    expect(
      ledger.acquire('ttl::pool', { requests: 1, tokens: 10 }, ttlPool, now, 100),
    ).toBeDefined();
    expect(
      ledger.acquire('ttl::pool', { requests: 1, tokens: 10 }, ttlPool, now + 50, 100),
    ).toBeUndefined();
    expect(
      ledger.acquire('ttl::pool', { requests: 1, tokens: 10 }, ttlPool, now + 200, 100),
    ).toBeDefined();
    expect(() => {
      ledger.release('ttl::pool:missing');
    }).not.toThrow();
  });
});
