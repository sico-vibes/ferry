import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ModelInfoSchema, ProviderSchema } from '@ferry/shared';
import { startHarness, textTurn, waitFor, type CoreHarness } from './qa-w3-harness.js';
vi.setConfig({ testTimeout: 30000 });
let h: CoreHarness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());
it('checks only free models, records confidence and timing, and preserves custom profiles', async () => {
  const original = await h.rpc.profiles.list();
  const template = h.services.catalog.models.find(
    (model) => model.providerId === 'openrouter' && model.free && model.toolCalling,
  );
  if (!template) throw new Error('Missing free fixture');
  h.services.models.replace('openrouter', [
    ModelInfoSchema.parse({
      ...template,
      ref: 'openrouter/check-paid',
      free: false,
      priceInPerM: 1,
      priceOutPerM: 1,
    }),
    template,
  ]);
  h.server.requests.splice(0);
  h.server.setResponses([textTurn('Ready.')]);
  const progress: import('@ferry/shared').ProviderCheckProgress[] = [];
  const off = h.rpc.on('providers.check', (event) => progress.push(event));
  try {
    const started = await h.rpc.providers.startChecks();
    await waitFor(async () => !(await h.rpc.providers.checkProgress(started.id)).running);
    const result = await h.rpc.providers.checkProgress(started.id);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ ok: true, modelRef: template.ref, sampleCount: 1 });
    expect(result.results[0]?.firstResponseMs).toBeGreaterThanOrEqual(0);
    expect(
      h.server.requests.filter((request) => request.url.includes('/chat/completions')),
    ).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('Reply with Ready.');
    expect(await h.rpc.profiles.list()).toEqual(original);
    expect(progress.at(-1)?.running).toBe(false);
  } finally {
    off();
  }
});
it('cancels in-flight generations and does not publish recommendations as successful', async () => {
  h.server.requests.splice(0);
  h.server.setResponses([textTurn('Ready.', { delayMs: 1000 })]);
  const started = await h.rpc.providers.startChecks();
  await waitFor(() =>
    h.server.requests.some((request) => request.url.includes('/chat/completions')),
  );
  await h.rpc.providers.cancelChecks(started.id);
  await waitFor(async () => !(await h.rpc.providers.checkProgress(started.id)).running);
  expect(await h.rpc.providers.checkProgress(started.id)).toMatchObject({
    cancelled: true,
    results: [{ ok: false }],
  });
});
it('skips metered paid connections unless a free route is explicitly covered', async () => {
  const provider = h.services.providers.get('openrouter');
  const model = h.services.models.list('openrouter')[0];
  if (!provider || !model) throw new Error('Missing fixtures');
  h.services.providers.put(
    ProviderSchema.parse({ ...provider, tag: 'paid', billingEnabled: true }),
  );
  h.services.models.replace('openrouter', [
    ModelInfoSchema.parse({
      ...model,
      ref: 'openrouter/metered-fixture',
      free: false,
      priceInPerM: 1,
      priceOutPerM: 1,
    }),
  ]);
  h.server.requests.splice(0);
  const started = await h.rpc.providers.startChecks();
  await waitFor(async () => !(await h.rpc.providers.checkProgress(started.id)).running);
  expect((await h.rpc.providers.checkProgress(started.id)).results).toEqual([]);
  expect(h.server.requests).toEqual([]);
});
