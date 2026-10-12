import { expect, it, vi } from 'vitest';
import { ProviderIdSchema, isOpenCodeAppModel } from '@ferry/shared';
import { startHarness, textTurn, waitFor } from './qa-w3-harness.js';
vi.setConfig({ testTimeout: 30000 });
it('reports a free-tier denial without marking the key invalid or enabling paid fallback', async () => {
  const h = await startHarness({ provider: 'opencode' });
  try {
    const model = h.services.catalog.models.find(
      (model) => model.providerId === 'opencode' && model.free,
    );
    if (!model) throw new Error('Missing free model');
    h.services.models.replace('opencode', [{ ...model, apiAccessVerified: false }]);
    const before = await h.rpc.settings.get();
    h.server.requests.splice(0);
    h.server.setResponses([
      {
        status: 403,
        body: {
          type: 'FreeTierError',
          error: { message: "OpenCode's free tier can only be used from within OpenCode" },
        },
      },
    ]);
    const started = await h.rpc.providers.startChecks();
    await waitFor(async () => !(await h.rpc.providers.checkProgress(started.id)).running);
    const result = (await h.rpc.providers.checkProgress(started.id)).results[0];
    expect(result).toMatchObject({
      ok: false,
      paid: false,
      authentication: 'unknown',
      modelRef: model.ref,
    });
    expect(result?.message).toContain('standard API');
    expect(h.services.providers.get('opencode')?.freeTierUnsupported).toBe(true);
    expect(h.services.models.list('opencode')[0]?.apiAccessVerified).toBe(false);
    expect(await h.rpc.settings.get()).toEqual(before);
    expect(
      h.server.requests.filter((request) => request.url.includes('/chat/completions')),
    ).toHaveLength(1);
  } finally {
    await h.close();
  }
});

it('retries ordinary free Zen generation after a previous denial and makes only the verified model routeable', async () => {
  const h = await startHarness({ provider: 'opencode' });
  try {
    const id = ProviderIdSchema.parse('opencode');
    const model = h.services.catalog.models.find((m) => m.providerId === id && m.free);
    const provider = h.services.providers.get(id);
    if (!model || !provider) throw new Error('Missing Zen fixture');
    h.services.providers.put({
      ...provider,
      freeTierUnsupported: true,
      excludedModelRefs: [model.ref],
    });
    h.services.models.replace(id, [{ ...model, apiAccessVerified: false }]);
    h.server.setResponses([textTurn('Ready.')]);
    h.server.requests.splice(0);
    const start = await h.rpc.providers.startChecks();
    await waitFor(async () => !(await h.rpc.providers.checkProgress(start.id)).running);
    const progress = await h.rpc.providers.checkProgress(start.id);
    expect(progress.results).toMatchObject([{ ok: true, paid: false, modelRef: model.ref }]);
    expect(progress.entries).toContainEqual(
      expect.objectContaining({ providerId: 'opencode', state: 'complete' }),
    );
    const restored = h.services.models.list(id).find((m) => m.ref === model.ref);
    expect(restored && isOpenCodeAppModel(restored)).toBe(false);
    expect(h.services.providers.get(id)?.freeTierUnsupported).toBe(false);
    expect(h.server.requests.filter((r) => r.url.includes('/chat/completions'))).toHaveLength(1);
    expect(h.server.requests.at(-1)?.headers['user-agent']).toMatch(/^Ferry\//);
    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    expect((await h.rpc.models.candidates(session.id)).some((m) => m.ref === model.ref)).toBe(true);
  } finally {
    await h.close();
  }
});
