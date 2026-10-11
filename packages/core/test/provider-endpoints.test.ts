import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startHarness, type CoreHarness } from './qa-w3-harness.js';
import { providerBaseUrl } from '../src/provider-endpoints.js';
vi.setConfig({ testTimeout: 30000 });
let h: CoreHarness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
it('persists validated endpoints, clears stale evidence and preserves saved credentials', async () => {
  const id = (await h.rpc.providers.list()).find((provider) => provider.id === 'lmstudio')?.id;
  if (!id) throw new Error('Missing local provider');
  await h.rpc.settings.update({ providerEndpoints: { [id]: 'http://localhost:1234/v1' } });
  expect(providerBaseUrl(h.services, id)).toBe('http://localhost:1234/v1');
  const key = h.services.providerKeys.get('openrouter');
  const previous = h.services.providers.get('openrouter');
  if (!previous) throw new Error('Missing connected provider');
  h.services.settings.put('provider-check-results', [{ providerId: 'openrouter' }]);
  await h.rpc.settings.update({ providerEndpoints: { [previous.id]: 'http://localhost:8080/v1' } });
  expect(h.services.providerKeys.get('openrouter')).toEqual(key);
  expect(h.services.models.list('openrouter')).toEqual([]);
  expect(h.services.settings.get('provider-check-results')).toEqual([]);
  expect(h.services.providers.get('openrouter')?.modelsVerifiedAt).toBeNull();
  await expect(
    h.rpc.settings.update({ providerEndpoints: { [id]: 'https://user:password@example.test/v1' } }),
  ).rejects.toThrow();
  await expect(
    h.rpc.settings.update({ providerEndpoints: { [id]: 'file:///private' } }),
  ).rejects.toThrow();
});
it('persists every extended routing control through the real RPC patch schema', async () => {
  const before = await h.rpc.settings.get();
  const updated = await h.rpc.settings.update({
    routing: {
      ...before.routing,
      qualityWeight: 7,
      avoidTrainingProviders: true,
      textToolFallbackEnabled: true,
    },
  });
  expect(updated.routing).toMatchObject({
    qualityWeight: 7,
    avoidTrainingProviders: true,
    textToolFallbackEnabled: true,
  });
  expect((await h.rpc.settings.get()).routing).toEqual(updated.routing);
});
