import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { ModelInfoSchema, ProviderIdSchema, ProviderSchema } from '@ferry/shared';
import { getGatewayController } from '../src/gateway.js';
import { startHarness, textTurn, toolTurn, waitFor, type CoreHarness } from './qa-w3-harness.js';

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
async function key(model: string, paid = false, budgetUsd = 1) {
  const created = await h.rpc.gateway.createKey({ name: 'Safety fixture', profile: 'none' });
  await h.rpc.gateway.updateKey({
    id: created.key.id,
    patch: { allowedModels: [model], ...(paid ? { paidBackup: true, budgetUsd } : {}) },
  });
  return created;
}
async function request(secret: string, model: string) {
  return fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 1 }),
  });
}
function paidModel(unknown = false) {
  const template = h.services.catalog.models.find(
    (model) => model.providerId === 'openrouter' && model.toolCalling,
  );
  if (!template) throw new Error('Missing fixture model');
  const model = ModelInfoSchema.parse({
    ...template,
    ref: `openrouter/safety-paid-${unknown ? 'unknown' : 'priced'}`,
    free: false,
    priceInPerM: unknown ? null : 1000,
    priceOutPerM: unknown ? null : 1000,
    maxOutput: 100,
  });
  h.services.models.replace('openrouter', [model]);
  return model;
}
it('requires explicit budgets on legacy paid-capable keys and blocks unknown pricing', async () => {
  let model = paidModel();
  const legacy = await key(model.ref);
  let response = await request(legacy.secret, model.ref);
  expect(response.status).toBe(402);
  expect(await response.json()).toMatchObject({ error: { code: 'budget_exhausted' } });
  expect(h.server.requests).toHaveLength(0);
  await expect(
    h.rpc.gateway.updateKey({ id: legacy.key.id, patch: { paidBackup: true } }),
  ).rejects.toThrow('positive');
  model = paidModel(true);
  const paid = await key(model.ref, true);
  response = await request(paid.secret, model.ref);
  expect(response.status).toBe(402);
  expect(h.server.requests).toHaveLength(0);
});
it('cannot loosen a free key policy by choosing a paid model or profile alias', async () => {
  const model = paidModel();
  const created = await h.rpc.gateway.createKey({ name: 'Free', profile: 'auto-free' });
  for (const name of [model.ref, 'ferry/best']) {
    const response = await request(created.secret, name);
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(h.server.requests).toHaveLength(0);
});
it('reserves spend before concurrent HTTP requests dispatch and persists metadata only', async () => {
  const model = paidModel();
  h.server.setResponses([textTurn('Gateway answer', { delayMs: 30 })]);
  const created = await key(model.ref, true, 0.075);
  const responses = await Promise.all([
    request(created.secret, model.ref),
    request(created.secret, model.ref),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 402]);
  expect(
    h.server.requests.filter((request) => request.url.endsWith('/chat/completions')),
  ).toHaveLength(1);
  const records = await h.rpc.gateway.requests();
  expect(records.some((record) => record.keyId === created.key.id && record.status === 'ok')).toBe(
    true,
  );
  expect(JSON.stringify(records)).not.toContain('Gateway answer');
  expect(
    h.services.db.client.prepare('SELECT count(*) AS total FROM gateway_requests').get(),
  ).toEqual({ total: records.length });
  const rows = h.services.db.client
    .prepare('SELECT amount_usd,estimated FROM spend_charges WHERE key_id=?')
    .all(created.key.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ estimated: 1 });
  const repeat = await request(created.secret, model.ref);
  expect(repeat.status).toBe(402);
  expect(
    h.server.requests.filter((request) => request.url.endsWith('/chat/completions')),
  ).toHaveLength(1);
});
it.each(['llm7', 'ollama', 'lmstudio'])(
  'routes %s without stored credentials when its adapter permits it',
  async (provider) => {
    const id = ProviderIdSchema.parse(provider);
    const template = h.services.catalog.models.find((model) => model.providerId === 'openrouter');
    if (!template) throw new Error('Missing model');
    const model = ModelInfoSchema.parse({
      ...template,
      providerId: id,
      ref: `${provider}/keyless-fixture`,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    });
    h.services.providers.put(
      ProviderSchema.parse({
        ...h.services.providers.get('openrouter'),
        id,
        name: 'Anonymous fixture',
        enabled: true,
        keyStatus: 'not_applicable',
      }),
    );
    h.services.models.replace(id, [model]);
    h.services.env[`FERRY_PROVIDER_BASE_URL_${provider.toUpperCase()}`] = `${h.server.baseUrl}/v1`;
    const created = await key(model.ref);
    const unavailableKeyring = vi
      .spyOn(h.services.secrets, 'get')
      .mockRejectedValue(new Error('Fixture keyring unavailable'));
    try {
      expect((await request(created.secret, model.ref)).status).toBe(200);
      expect((await h.rpc.providers.probe(id)).ok).toBe(true);
      expect(unavailableKeyring).not.toHaveBeenCalled();
    } finally {
      unavailableKeyring.mockRestore();
    }
    expect(h.server.requests.at(-1)?.headers.authorization).toBeUndefined();
  },
);
it('native tools enforce persistent Core rules', async () => {
  h.server.setResponses([
    toolTurn('write_file', { path: 'blocked.txt', content: 'Denied' }),
    textTurn('Stopped'),
  ]);
  const free = h.services.catalog.models.find(
    (model) => model.providerId === 'openrouter' && model.free && model.toolCalling,
  );
  if (!free) throw new Error('Missing free model');
  h.services.models.replace('openrouter', [free]);
  await h.rpc.settings.update({
    permissionMode: 'full_auto',
    permissionRules: [{ effect: 'deny', tool: 'write_file', pattern: 'blocked.txt' }],
  });
  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(session.id, free.ref);
  await h.rpc.sessions.send(session.id, { text: 'Write blocked.txt' });
  await waitFor(async () =>
    (await h.rpc.sessions.get(session.id)).messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === 'tool_call' &&
          part.status === 'failed' &&
          part.output?.text.includes('user rule deny'),
      ),
    ),
  );
  expect((await h.rpc.settings.get()).permissionRules).toEqual([
    { effect: 'deny', tool: 'write_file', pattern: 'blocked.txt' },
  ]);
  expect(getGatewayController(h.services)?.requests().length).toBeGreaterThan(0);
});
it('keeps global monthly and session caps when only the daily cap changes', async () => {
  await h.rpc.settings.update({ paidCaps: { sessionUsd: 1, monthlyUsd: 2 } });
  const saved = await h.rpc.settings.update({ paidCaps: { dailyUsd: 3 } });
  expect(saved.paidCaps).toEqual({ sessionUsd: 1, dailyUsd: 3, monthlyUsd: 2 });
});
