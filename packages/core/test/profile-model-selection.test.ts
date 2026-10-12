import { expect, it, vi } from 'vitest';
import { ProfileIdSchema } from '@ferry/shared';
import { startHarness, textTurn } from './qa-w3-harness.js';
vi.setConfig({ testTimeout: 30000 });

it('persists a guided profile model selection and enforces it through Gateway routing and generation', async () => {
  const h = await startHarness();
  try {
    const base = (await h.rpc.profiles.list()).find((profile) => profile.name === 'Auto-Free');
    const model = h.services.models.list('openrouter')[0];
    const other = h.services.catalog.models.find(
      (item) =>
        item.providerId === 'openrouter' &&
        item.free &&
        item.toolCalling &&
        item.ref !== model?.ref,
    );
    if (!base || !model || !other) throw new Error('Missing routing fixtures');
    h.services.models.replace('openrouter', [model, other]);
    const id = ProfileIdSchema.parse('profile_custom_guided_selection');
    const saved = await h.rpc.profiles.save({
      ...base,
      id,
      name: 'Guided selection',
      builtin: false,
      allowedProviders: [model.providerId],
      allowedModelRefs: [model.ref],
      fallbackChain: [
        { provider: model.providerId, patterns: [model.ref.slice(model.providerId.length + 1)] },
      ],
    });
    expect(saved.allowedModelRefs).toEqual([model.ref]);
    expect(
      (await h.rpc.profiles.list()).find((profile) => profile.id === id)?.allowedModelRefs,
    ).toEqual([model.ref]);
    const created = await h.rpc.gateway.createKey({ name: 'Guided profile', profile: id });
    const explanation = await h.rpc.gateway.routing(created.key.id);
    expect(explanation.eligible.map((row) => row.modelRef)).toEqual([model.ref]);
    const state = (await h.rpc.gateway.setSettings({
      enabled: true,
      port: 0,
      allowLan: false,
    })) as { status: { url: string } };
    h.server.requests.splice(0);
    h.server.setResponses([textTurn('Selected model works.')]);
    const response = await fetch(`${state.status.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ferry/auto',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 16,
      }),
    });
    expect(response.status).toBe(200);
    expect(h.server.requests.at(-1)?.body).toMatchObject({
      model: model.ref.slice(model.providerId.length + 1),
    });
  } finally {
    await h.close();
  }
});
