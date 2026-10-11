import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ModelRefSchema, ProfileIdSchema } from '@ferry/shared';
import { startHarness, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });
let harness: CoreHarness;

beforeAll(async () => {
  harness = await startHarness();
  const base = harness.services.models.list('openrouter')[0];
  const provider = harness.services.providers.get('openrouter');
  if (!base || !provider) throw new Error('Missing fixture provider');
  const models = Array.from({ length: 1_000 }, (_, index) => ({
    ...base,
    ref: ModelRefSchema.parse(`openrouter/bulk-${String(index)}:free`),
    name: `Bulk model ${String(index)}`,
    verified: true,
    verifiedAt: harness.services.clock.now().toISOString(),
  }));
  harness.services.models.replace('openrouter', models);
  harness.services.providers.put({
    ...provider,
    availableModels: models,
    modelCount: models.length,
    modelsVerifiedAt: harness.services.clock.now().toISOString(),
  });
  await harness.rpc.profiles.activate(ProfileIdSchema.parse('profile_builtin_auto_free'));
});

afterAll(async () => harness.close());

it('pages a large discovered catalog without decoding the provider row for every model', async () => {
  const reads = vi.spyOn(harness.services.providers, 'get');
  try {
    const page = await harness.rpc.models.page({ limit: 20, query: 'bulk-' });
    expect(page.total).toBe(1_000);
    expect(page.items).toHaveLength(20);
    expect(page.items.every((model) => model.verified && model.free)).toBe(true);
    expect(reads.mock.calls.length).toBeLessThan(100);
  } finally {
    reads.mockRestore();
  }
});

it('bounds provider reads during Auto-Free capacity refreshes by provider count', () => {
  const reads = vi.spyOn(harness.services.providers, 'get');
  try {
    const summary = harness.services.quota.capacitySummary();
    expect(summary.perProvider.some((provider) => provider.providerId === 'openrouter')).toBe(true);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(
      harness.services.catalog.providers.length * 3,
    );
  } finally {
    reads.mockRestore();
  }
});

it('explains Gateway routing without rebuilding the catalog for every excluded model', async () => {
  const reads = vi.spyOn(harness.services.providers, 'get');
  try {
    const routing = await harness.rpc.gateway.routing();
    expect(routing.summary).toContain('Auto');
    expect(routing.eligible.some((model) => model.modelRef.startsWith('openrouter/bulk-'))).toBe(
      true,
    );
    expect(reads.mock.calls.length).toBeLessThan(500);
  } finally {
    reads.mockRestore();
  }
});
