import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GatewayRequestRecordSchema } from '@ferry/shared';
import { createRpcFerryClient } from '@ferry/client';
import { createCoreHost, createMemoryTransportPair } from '../src/index.js';
import { getGatewayController } from '../src/gateway.js';
import { startHarness, textTurn, type CoreHarness } from './qa-w3-harness.js';
vi.setConfig({ testTimeout: 30000 });
let h: CoreHarness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

it('pages and searches durable metadata beyond the recent view and aggregates actual, cached and estimated usage', async () => {
  h.services.db.client.exec('DELETE FROM gateway_requests');
  const insert = h.services.db.client.prepare(
    'INSERT INTO gateway_requests(id,at,data_json) VALUES(?,?,?)',
  );
  for (let index = 0; index < 260; index++) {
    const record = GatewayRequestRecordSchema.parse({
      id: `history-${String(index).padStart(3, '0')}`,
      at: new Date(Date.now() - index * 1000).toISOString(),
      keyId: index % 2 ? 'a' : 'b',
      keyName: index % 2 ? 'Codex fixture' : 'Claude fixture',
      requestedModel: 'ferry/auto',
      modelRef: 'openrouter/fixture:free',
      providerId: 'openrouter',
      status: 'ok',
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 50,
      latencyMs: 200,
      firstResponseMs: 80,
      error: null,
      costUsd: 0.01,
      estimatedCost: index % 2 === 1,
      outcome: 'completed',
      attempts: [{ model: 'openrouter/fixture:free', status: 'served', durationMs: 200 }],
    });
    insert.run(record.id, record.at, JSON.stringify(record));
  }
  expect(await h.rpc.gateway.requests()).toHaveLength(200);
  const page = await h.rpc.gateway.history({ limit: 100 });
  expect(page.total).toBe(260);
  expect(page.records).toHaveLength(100);
  expect(page.nextOffset).toBe(100);
  expect((await h.rpc.gateway.history({ offset: 200, limit: 100 })).records).toHaveLength(60);
  expect((await h.rpc.gateway.history({ query: 'codex', keyId: 'a' })).total).toBe(130);
  expect(await h.rpc.gateway.request('history-001')).toMatchObject({
    keyId: 'a',
    cachedTokens: 50,
    firstResponseMs: 80,
  });
  const usage = await h.rpc.gateway.usage({ groupBy: 'provider' });
  expect(usage.groups[0]).toMatchObject({
    requests: 260,
    inputTokens: 26000,
    outputTokens: 5200,
    cachedTokens: 13000,
    unknownCosts: 0,
  });
  expect(usage.groups[0]?.actualUsd).toBeCloseTo(1.3);
  expect(usage.groups[0]?.estimatedUsd).toBeCloseTo(1.3);
  const old = {
    id: 'old-history',
    at: new Date(Date.now() - 8 * 86400000).toISOString(),
    data_json: JSON.stringify({
      ...page.records[0],
      id: 'old-history',
      at: new Date(Date.now() - 8 * 86400000).toISOString(),
    }),
  };
  insert.run(old.id, old.at, old.data_json);
  expect((await h.rpc.gateway.history({ range: '7d' })).total).toBe(260);
  expect((await h.rpc.gateway.history({ range: '30d' })).total).toBe(261);
});

it('rotates a key without losing its client, permissions, caps or usage and rejects the old secret', async () => {
  const created = await h.rpc.gateway.createKey({ name: 'Named fixture', profile: 'auto-free' });
  await h.rpc.gateway.updateKey({
    id: created.key.id,
    patch: { client: 'Codex CLI', tokenLimitPerDay: 10000, concurrencyLimit: 1 },
  });
  const rotated = await h.rpc.gateway.rotateKey(created.key.id);
  expect(rotated.key.id).toBe(created.key.id);
  expect(rotated.secret).not.toBe(created.secret);
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('Missing fixture Gateway controller');
  const status = await controller.start({ enabled: true, port: 0, allowLan: false });
  if (!status.url) throw new Error('Fixture Gateway did not start.');
  const url = status.url;
  const list = (secret: string) =>
    fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
  expect((await list(created.secret)).status).toBe(401);
  expect((await list(rotated.secret)).status).toBe(200);
  expect(await h.rpc.gateway.keySecret(created.key.id)).toBe(rotated.secret);
  expect((await h.rpc.gateway.listKeys()).find((key) => key.id === created.key.id)).toMatchObject({
    client: 'Codex CLI',
    tokenLimitPerDay: 10000,
    concurrencyLimit: 1,
  });
  await h.rpc.gateway.revokeKey(created.key.id);
  expect((await list(rotated.secret)).status).toBe(401);
});

it.each(['chat', 'responses', 'anthropic'] as const)(
  'verifies %s through the created key and records real serving metadata',
  async (protocol) => {
    h.server.setResponses([textTurn('Ready.')]);
    const created = await h.rpc.gateway.createKey({
      name: `Verify ${protocol}`,
      profile: 'auto-free',
    });
    const result = await h.rpc.gateway.testConnection({ id: created.key.id, protocol });
    expect(result).toMatchObject({ ok: true });
    expect(result.requestId).toBeTruthy();
    if (!result.requestId) throw new Error('Verification returned no request ID');
    const record = await h.rpc.gateway.request(result.requestId);
    expect(record).toMatchObject({
      keyId: created.key.id,
      status: 'ok',
      outcome: 'completed',
      requestedModel: 'ferry/auto',
    });
    expect(record?.attempts?.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(record)).not.toContain('Reply with Ready.');
    expect(JSON.stringify(record)).not.toContain('Ready.');
  },
);

it('records Bench evidence without altering custom presets or enabling paid checks', async () => {
  const profiles = await h.rpc.profiles.list();
  const report = {
    schemaVersion: 1,
    kind: 'bench',
    generatedAt: new Date().toISOString(),
    runs: [{ task: 'fixture', status: 'pass', modelsUsed: ['openrouter/fixture:free'] }],
  };
  expect(await h.rpc.profiles.importCodingResults(report)).toMatchObject({ imported: 1, total: 1 });
  expect(await h.rpc.profiles.importCodingResults(report)).toMatchObject({ imported: 1, total: 1 });
  expect(await h.rpc.profiles.list()).toEqual(profiles);
  const created = await h.rpc.gateway.createKey({
    name: 'Paid checks prohibited',
    profile: 'best',
  });
  await h.rpc.gateway.updateKey({ id: created.key.id, patch: { paidBackup: true, budgetUsd: 1 } });
  await expect(h.rpc.gateway.testConnection({ id: created.key.id })).rejects.toThrow('free-only');
});

it('keeps history and resumable onboarding settings after a Core restart', async () => {
  await h.rpc.settings.update({
    onboarding: {
      step: 5,
      use: 'both',
      keyId: 'resume-key',
      keyName: 'Personal API',
      paidBackup: false,
      budgetUsd: null,
      verifiedRequestId: 'history-001',
    },
  });
  await getGatewayController(h.services)?.stop();
  await h.host.stop();
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({
    dataDir: h.dataDir,
    transport: coreTransport,
    env: {
      ...process.env,
      FERRY_TEST_KEYRING_NAMESPACE: 'g1-b-restart-fixture',
      FERRY_PROVIDER_BASE_URL_OPENROUTER: `${h.server.baseUrl}/v1`,
    },
  });
  const rpc = createRpcFerryClient(clientTransport);
  try {
    await rpc.hello;
    expect((await rpc.settings.get()).onboarding).toMatchObject({
      step: 5,
      keyId: 'resume-key',
      verifiedRequestId: 'history-001',
    });
    expect(await rpc.gateway.request('history-001')).toMatchObject({ keyId: 'a' });
    expect((await rpc.gateway.history({ range: '30d' })).total).toBeGreaterThan(260);
  } finally {
    rpc.close();
    await host.stop();
  }
});
