import { expect, it } from 'vitest';
import { ProviderIdSchema } from '@ferry/shared';
import { createSessionDependencies } from '../src/session-deps.js';
import { startHarness } from './qa-w3-harness.js';
it('shows OpenCode-only models but excludes them from Ferry routing', async () => {
  const id = ProviderIdSchema.parse('opencode');
  const h = await startHarness({ provider: id });
  try {
    const free = h.services.catalog.models.find((model) => model.ref === 'opencode/big-pickle');
    const paid = h.services.catalog.models.find((model) => model.providerId === id && !model.free);
    if (!free || !paid) throw new Error('Missing Zen fixtures');
    h.services.models.replace(id, [free, paid]);
    const best = (await h.rpc.profiles.list()).find((profile) => profile.name === 'Best Available');
    if (!best) throw new Error('Missing profile');
    const gateway = createSessionDependencies(h.services, () => undefined).gateway;
    expect(gateway.resolveCandidates(best, 'search').some((model) => model.ref === free.ref)).toBe(
      false,
    );
    expect((await h.rpc.models.list(id)).map((model) => model.ref)).toEqual([free.ref, paid.ref]);
    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    expect(
      (await h.rpc.models.candidates(session.id)).some((model) => model.ref === free.ref),
    ).toBe(false);
    await expect(h.rpc.models.select(session.id, free.ref)).rejects.toThrow('OpenCode app');
    await h.rpc.providers.setKey(id, 'fixture-account-key');
    await expect(h.rpc.providers.addKey(id, 'Second key', 'fixture-second-key')).rejects.toThrow(
      /stack|replace/i,
    );
    // A successful ordinary API generation may establish legitimate free access for this key.
    h.services.models.replace(id, [{ ...free, apiAccessVerified: true }, paid]);
    const created = await h.rpc.gateway.createKey({ name: 'Standard Zen API', profile: 'none' });
    await h.rpc.gateway.updateKey({ id: created.key.id, patch: { allowedModels: [free.ref] } });
    const status = (await h.rpc.gateway.setSettings({
      enabled: true,
      port: 0,
      allowLan: false,
    })) as { status: { url: string } };
    const response = await fetch(`${status.status.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: free.ref,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1,
      }),
    });
    expect(response.status).toBe(200);
    expect(h.server.requests.at(-1)?.headers['user-agent']).toMatch(/^Ferry\//);
    expect(h.server.requests.at(-1)?.headers.authorization).toBe('Bearer fixture-account-key');
  } finally {
    await h.close();
  }
}, 30_000);
