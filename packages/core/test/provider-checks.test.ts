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
it('paid checks require explicit bounded approval and never change inference settings or keys', async () => {
  const model = h.services.models.list('openrouter')[0];
  if (!model) throw new Error('Missing fixture');
  const settings = await h.rpc.settings.get();
  const keys = await h.rpc.gateway.listKeys();
  h.server.setResponses([textTurn('Ready.')]);
  await expect(h.rpc.providers.startChecks({ approvedCostUsd: 0 })).rejects.toThrow();
  await expect(h.rpc.providers.startChecks({ approvedCostUsd: 2 })).rejects.toThrow();
  const started = await h.rpc.providers.startChecks({ approvedCostUsd: 0.001 });
  await waitFor(async () => !(await h.rpc.providers.checkProgress(started.id)).running);
  const progress = await h.rpc.providers.checkProgress(started.id);
  expect(progress.results).toHaveLength(1);
  expect(progress.results[0]).toMatchObject({ ok: true, paid: true, authentication: 'accepted' });
  expect(progress.results[0]?.costUsd).toBeLessThanOrEqual(0.001);
  expect(await h.rpc.settings.get()).toEqual(settings);
  expect(await h.rpc.gateway.listKeys()).toEqual(keys);
  const charges = h.services.db.client
    .prepare('SELECT amount_usd FROM spend_charges WHERE id LIKE ?')
    .all(`check:${started.id}:%`);
  expect(charges).toHaveLength(1);
});
it('blocks paid dispatch before spending beyond the approved ceiling', async () => {
  h.server.requests.splice(0);
  const started = await h.rpc.providers.startChecks({ approvedCostUsd: 0.000001 });
  await waitFor(async () => !(await h.rpc.providers.checkProgress(started.id)).running);
  expect((await h.rpc.providers.checkProgress(started.id)).results[0]?.ok).toBe(false);
  expect((await h.rpc.providers.checkProgress(started.id)).results[0]?.sampleCount).toBe(0);
  expect(h.server.requests.filter((row) => row.url.includes('/chat/completions'))).toHaveLength(0);
});
it('runs at most two free/API/local checks and cancellation never starts the queued third', async () => {
  const template = h.services.models.list('openrouter')[0];
  if (!template) throw new Error('Missing model');
  const providers = await h.rpc.providers.list();
  const localEndpoints = Object.fromEntries(
    ['ollama', 'lmstudio'].map((id) => [id, `${h.server.baseUrl}/v1`]),
  );
  await h.rpc.settings.update({ providerEndpoints: localEndpoints });
  for (const id of ['openrouter', 'ollama', 'lmstudio']) {
    const provider = providers.find((provider) => provider.id === id);
    if (!provider) throw new Error('Missing provider');
    h.services.providers.put({
      ...provider,
      enabled: true,
      health: 'ok',
      billingEnabled: false,
      modelsVerifiedAt: new Date().toISOString(),
    });
    h.services.models.replace(id, [
      ModelInfoSchema.parse({
        ...template,
        ref: `${id}/concurrency-fixture:free`,
        providerId: id,
        free: true,
        toolCalling: false,
        priceInPerM: 0,
        priceOutPerM: 0,
      }),
    ]);
  }
  h.server.requests.splice(0);
  h.server.setResponses([
    textTurn('Ready.', { delayMs: 2000 }),
    textTurn('Ready.', { delayMs: 2000 }),
    textTurn('Ready.'),
  ]);
  const started = await h.rpc.providers.startChecks();
  await waitFor(
    () =>
      h.server.requests.filter((request) => request.url.includes('/chat/completions')).length >= 2,
  );
  expect(
    h.server.requests.filter((request) => request.url.includes('/chat/completions')),
  ).toHaveLength(2);
  await h.rpc.providers.cancelChecks(started.id);
  await waitFor(async () => !(await h.rpc.providers.checkProgress(started.id)).running);
  expect(
    h.server.requests.filter((request) => request.url.includes('/chat/completions')),
  ).toHaveLength(2);
});
