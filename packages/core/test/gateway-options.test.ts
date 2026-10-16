import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { startHarness, textTurn, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });
let h: CoreHarness;
let endpoint: string;
beforeAll(async () => {
  h = await startHarness();
  const status = (await h.rpc.gateway.setSettings({ enabled: true, port: 0, allowLan: false })) as {
    status: { url: string };
  };
  endpoint = status.status.url;
});
beforeEach(() => {
  h.server.requests.splice(0);
  h.server.setResponses([textTurn('Gateway answer')]);
  h.services.db.client.exec(
    'DELETE FROM spend_reservations; DELETE FROM spend_charges; DELETE FROM requests; DELETE FROM usage_daily; DELETE FROM cooldowns;',
  );
});
afterAll(async () => {
  await h.close();
});

async function freeKey() {
  const created = await h.rpc.gateway.createKey({ name: 'Options fixture', profile: 'none' });
  const model = h.services.models
    .list('openrouter')
    .find((candidate) => candidate.free && candidate.toolCalling);
  if (!model) throw new Error('Missing free fixture model');
  await h.rpc.gateway.updateKey({ id: created.key.id, patch: { allowedModels: [model.ref] } });
  return { created, model };
}

const protocols = [
  ['/v1/chat/completions', 'chat'],
  ['/v1/responses', 'responses'],
  ['/v1/messages', 'messages'],
] as const;

function payloadFor(kind: string, override: Record<string, unknown>) {
  const base =
    kind === 'responses'
      ? { input: 'Hello' }
      : kind === 'messages'
        ? { max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] }
        : { messages: [{ role: 'user', content: 'Hello' }] };
  return { ...base, ...override };
}

it.each(protocols)(
  'rejects an explicit unsupported service_tier on %s before dispatch',
  async (path, kind) => {
    const { created, model } = await freeKey();
    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(kind, { model: model.ref, service_tier: 'flex' })),
    });
    expect(response.status).toBe(400);
    expect(h.server.requests).toHaveLength(0);
  },
);

it.each(protocols)(
  'rejects fast/priority on a standard-API route before dispatch on %s',
  async (path, kind) => {
    const { created, model } = await freeKey();
    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(kind, { model: model.ref, service_tier: 'fast' })),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      'not supported in this beta',
    );
    expect(h.server.requests).toHaveLength(0);
  },
);

it.each(protocols)(
  'rejects a raw native reasoning_effort on the standard API before dispatch on %s',
  async (path, kind) => {
    const { created, model } = await freeKey();
    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        payloadFor(
          kind,
          kind === 'messages'
            ? {
                model: model.ref,
                thinking: { type: 'enabled', budget_tokens: 2048 },
                output_config: { effort: 'ultra' },
              }
            : { model: model.ref, reasoning_effort: 'ultra' },
        ),
      ),
    });
    expect(response.status).toBe(400);
    expect(h.server.requests).toHaveLength(0);
  },
);
