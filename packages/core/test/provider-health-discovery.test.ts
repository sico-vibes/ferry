import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '@ferry/secrets';
import { createRpcFerryClient } from '@ferry/client';
import { ProviderIdSchema, ProviderHealthSnapshotSchema } from '@ferry/shared';
import { BUILTIN_PROFILES } from '@ferry/router';
import { CoreHost, createMemoryTransportPair } from '../src/index.js';
import { createServices } from '../src/services.js';
import { domainRegistrars } from '../src/domains/index.js';
import { getModelDiscovery } from '../src/domains/model-discovery.js';
import { getProviderHealth } from '../src/provider-health.js';
import { createSessionDependencies } from '../src/session-deps.js';

vi.setConfig({ testTimeout: 30_000 });
describe('provider health and live model discovery', () => {
  it('hides undiscovered catalog models, retains the last good list, refreshes at six hours and on key changes, and clears model failures', async () => {
    const temporaryRoot = fileURLToPath(new URL('../../../.dev/test-tmp/', import.meta.url));
    await mkdir(temporaryRoot, { recursive: true });
    const dataDir = await mkdtemp(join(temporaryRoot, 'health-discovery-'));
    let now = new Date('2026-10-08T10:00:00.000Z');
    let failing = false;
    let calls = 0;
    let liveId = '';
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      await Promise.resolve();
      calls++;
      expect(init?.headers).toBeDefined();
      if (failing) return new Response('{}', { status: 503 });
      return Response.json({ data: [{ id: liveId, supported_parameters: ['tools'] }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const services = await createServices({
      dataDir: resolve(dataDir),
      clock: { now: () => now },
      env: { NODE_ENV: 'test', FERRY_PROVIDER_BASE_URL_OPENROUTER: 'http://127.0.0.1:1/v1' },
      secrets: new MemorySecretStore('health-discovery'),
    });
    const catalogModel = services.catalog.models.find(
      (model) => model.providerId === 'openrouter' && model.free && model.toolCalling,
    );
    if (!catalogModel) throw new Error('Missing OpenRouter fixture');
    liveId = catalogModel.ref.slice('openrouter/'.length);
    const [transport, clientTransport] = createMemoryTransportPair();
    const host = new CoreHost({ dataDir, transport, services });
    for (const register of domainRegistrars) register(host, services);
    await host.start();
    const rpc = createRpcFerryClient(clientTransport);
    const id = ProviderIdSchema.parse('openrouter');
    const discovery = getModelDiscovery(host, services);
    try {
      const emitted: unknown[] = [];
      rpc.on('providers.health.updated', (event) => emitted.push(event));
      await rpc.providers.setKey(id, 'discovery-fixture');
      await discovery.refresh(id);
      const listed = await rpc.models.list(id);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        ref: catalogModel.ref,
        verified: true,
        verifiedAt: now.toISOString(),
        contextWindow: catalogModel.contextWindow,
      });
      expect(
        services.catalog.models.filter((model) => model.providerId === id).length,
      ).toBeGreaterThan(listed.length);
      const successfulCalls = calls;
      now = new Date(now.getTime() + 6 * 3_600_000 - 1);
      await discovery.refreshIfStale(id);
      expect(calls).toBe(successfulCalls);
      now = new Date(now.getTime() + 1);
      failing = true;
      await discovery.refreshIfStale(id);
      expect(calls).toBe(successfulCalls + 1);
      expect(await rpc.models.list(id)).toEqual(listed);

      const health = getProviderHealth(services);
      health.record({
        providerId: id,
        modelRef: catalogModel.ref,
        status: 404,
        message: 'model_not_found',
        success: false,
      });
      const saved = services.providers.get(id);
      if (!saved) throw new Error('Provider missing');
      services.providers.put({ ...saved, excludedModelRefs: [catalogModel.ref] });
      expect(await rpc.models.list(id)).toEqual([]);
      const profile = BUILTIN_PROFILES.find((item) => item.name === 'Auto-Free');
      if (!profile) throw new Error('Profile missing');
      const dependencies = createSessionDependencies(services, () => undefined);
      expect(dependencies.gateway.resolveCandidates(profile, 'plan')).toEqual([]);

      failing = false;
      await rpc.providers.addKey(id, 'Sibling', 'second-fixture');
      await discovery.refresh(id);
      expect((await rpc.models.list(id))[0]).toMatchObject({
        verified: true,
        verifiedAt: now.toISOString(),
      });
      expect(health.tracker.snapshot(id).lockedModels).toEqual([]);
      expect(services.providers.get(id)?.excludedModelRefs).toEqual([]);
      health.record({
        providerId: id,
        keyId: `${id}:1`,
        status: 429,
        retryAfter: '30',
        success: false,
      });
      expect(dependencies.gateway.unavailableProviderKeyIds(id, catalogModel.ref)).toContain(
        `${id}:1`,
      );
      expect(dependencies.gateway.unavailableProviderKeyIds(id, catalogModel.ref)).not.toContain(
        `${id}:2`,
      );
      health.record({ providerId: id, status: 503, success: false });
      expect(dependencies.gateway.resolveCandidates(profile, 'plan')).toEqual([]);
      const snapshot = (await rpc.providers.health()).find((item) => item.providerId === id);
      expect(ProviderHealthSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot).toMatchObject({ state: 'down', breaker: 'open' });
      await vi.waitFor(() => {
        expect(emitted.length).toBeGreaterThan(0);
      });
      health.record({ providerId: id, success: true });
      const beforeReplacement = calls;
      await rpc.providers.setKey(id, 'replacement-fixture');
      await discovery.refresh(id);
      expect(calls).toBeGreaterThan(beforeReplacement);
    } finally {
      rpc.close();
      await host.stop();
      vi.unstubAllGlobals();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
