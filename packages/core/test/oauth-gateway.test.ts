import { expect, it, vi } from 'vitest';
import { ProviderSchema } from '@ferry/shared';
import { startHarness } from './qa-w3-harness.js';
import { oauthModelCatalog, streamOAuthChat } from '@ferry/oauth';

vi.mock('@ferry/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ferry/oauth')>()),
  streamOAuthChat: vi.fn().mockResolvedValue({
    text: 'OAuth fixture answer',
    toolCalls: [],
    inputTokens: 10,
    outputTokens: 5,
    finishReason: 'stop',
  }),
}));
it('executes an OAuth model through the Gateway without replacing the API connection', async () => {
  const h = await startHarness();
  try {
    const model = oauthModelCatalog.find((model) => model.providerId === 'oauth-anthropic');
    if (!model) throw new Error('Missing OAuth model');
    h.services.providers.put(
      ProviderSchema.parse({
        ...h.services.providers.get('openrouter'),
        id: model.providerId,
        name: 'Subscription fixture',
        tag: 'subscription_oauth',
        enabled: true,
        keyStatus: 'valid',
      }),
    );
    await h.rpc.settings.update({ allowSubscriptionOAuthRouting: true });
    const created = await h.rpc.gateway.createKey({ name: 'OAuth', profile: 'none' });
    await h.rpc.gateway.updateKey({
      id: created.key.id,
      patch: { allowedModels: [model.ref], paidBackup: true, budgetUsd: 1 },
    });
    const status = (await h.rpc.gateway.setSettings({
      enabled: true,
      port: 0,
      allowLan: false,
    })) as { status: { url: string } };
    const response = await fetch(`${status.status.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.ref,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: 'OAuth fixture answer' } }],
    });
    const call = vi.mocked(streamOAuthChat).mock.calls[0];
    expect(call?.[0]).toBe(h.services.secrets);
    expect(call?.[1].model.providerId).toBe('oauth-anthropic');
    expect(
      (await h.rpc.providers.list()).find((provider) => provider.id === 'anthropic')?.tag,
    ).not.toBe('subscription_oauth');
    expect(h.server.requests).toHaveLength(0);
  } finally {
    await h.close();
  }
}, 30_000);
