import { DEFAULT_SETTINGS } from '@ferry/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '@ferry/secrets';
import { runTelemetryRetention } from '@ferry/storage';
import { createServices, type FerryServices } from '../src/services.js';
import { reserveSpend } from '../src/spending.js';

vi.setConfig({ testTimeout: 30_000 });
let root: string;
let services: FerryServices;
const caps = { sessionUsd: null, dailyUsd: null, monthlyUsd: null };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferry-safety-'));
  services = await createServices({
    dataDir: root,
    env: { NODE_ENV: 'test' },
    secrets: new MemorySecretStore(),
  });
});
beforeEach(() => {
  services.db.client.exec(
    'DELETE FROM spend_reservations; DELETE FROM spend_charges; DELETE FROM requests; DELETE FROM usage_daily;',
  );
});
afterAll(async () => {
  await services.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
describe('atomic spending reservations', () => {
  for (const scope of ['key', 'profile', 'global'] as const) {
    it(`prevents two concurrent dispatches exceeding the ${scope} budget`, async () => {
      const outcomes = await Promise.allSettled(
        [1, 2].map((id) =>
          Promise.resolve().then(() =>
            reserveSpend(services, {
              id: String(id),
              keyId: 'client',
              profileId: 'profile',
              sessionId: 'session',
              amountUsd: 0.6,
              keyCaps: scope === 'key' ? { ...caps, monthlyUsd: 1 } : caps,
              profileCaps: scope === 'profile' ? { ...caps, dailyUsd: 1 } : caps,
              globalCaps: scope === 'global' ? { ...caps, dailyUsd: 1 } : caps,
            }),
          ),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect(
        services.db.client.prepare('SELECT count(*) AS total FROM spend_reservations').get(),
      ).toEqual({ total: 1 });
    });
  }
  it('reconciles actual usage and retains a conservative charge for interrupted dispatches', () => {
    const reserve = (id: string, amountUsd: number) =>
      reserveSpend(services, {
        id,
        amountUsd,
        keyId: 'client',
        profileId: 'profile',
        sessionId: 'session',
        profileCaps: caps,
        keyCaps: { ...caps, monthlyUsd: 1 },
        globalCaps: caps,
      });
    reserve('first', 0.8).settle(0.2, false);
    const second = reserve('second', 0.8);
    second.settle();
    second.settle();
    expect(() => reserve('third', 0.01)).toThrow('budget');
    expect(
      services.db.client.prepare('SELECT sum(amount_usd) AS total FROM spend_charges').get(),
    ).toEqual({ total: 1 });
  });
  it('counts native-agent history and reservations against Gateway global budgets', () => {
    const at = services.clock.now().toISOString();
    services.db.client
      .prepare('INSERT INTO requests(id,ts,provider,model,cost_usd,status) VALUES(?,?,?,?,?,?)')
      .run('native', at, 'openai', 'model', 0.4, 'success');
    reserveSpend(services, {
      id: 'native-pending',
      profileId: 'agent-profile',
      sessionId: 'agent',
      amountUsd: 0.4,
      profileCaps: caps,
      globalCaps: caps,
    });
    expect(() =>
      reserveSpend(services, {
        id: 'gateway',
        keyId: 'client',
        profileId: 'gateway-profile',
        sessionId: 'gateway',
        amountUsd: 0.3,
        profileCaps: caps,
        globalCaps: { ...caps, dailyUsd: 1 },
      }),
    ).toThrow('global');
  });
});
it('prunes expired telemetry and request metadata, preserving recent data and cost aggregates', () => {
  const db = services.db.client;
  const old = '2000-01-01T00:00:00.000Z';
  const recent = services.clock.now().toISOString();
  for (const at of [old, recent]) {
    db.prepare('INSERT INTO telemetry_logs(id,ts) VALUES(?,?)').run(`event-${at}`, at);
    db.prepare('INSERT INTO telemetry_turns(id,started_at) VALUES(?,?)').run(`turn-${at}`, at);
    db.prepare('INSERT INTO telemetry_model_switches(id,created_at) VALUES(?,?)').run(
      `switch-${at}`,
      at,
    );
    db.prepare('INSERT INTO gateway_requests(id,at,data_json) VALUES(?,?,?)').run(at, at, '{}');
    db.prepare(
      'INSERT INTO requests(id,ts,provider,model,cost_usd,status) VALUES(?,?,?,?,?,?)',
    ).run(at, at, 'openai', 'model', 0.4, 'success');
  }
  expect(runTelemetryRetention(db, new Date(Date.now() - 7 * 86_400_000))).toBeGreaterThanOrEqual(
    5,
  );
  for (const table of [
    'telemetry_turns',
    'telemetry_model_switches',
    'gateway_requests',
    'requests',
  ])
    expect(db.prepare(`SELECT count(*) AS total FROM ${table}`).get()).toEqual({ total: 1 });
  expect(db.prepare('SELECT cost_usd FROM usage_daily WHERE day=?').get('2000-01-01')).toEqual({
    cost_usd: 0.4,
  });
});

it('persists rules and retention across restart and prunes at startup and on schedule', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ferry-retention-restart-'));
  let running: FerryServices | undefined;
  const expired = '2000-01-01T00:00:00.000Z';
  try {
    running = await createServices({
      dataDir,
      env: { NODE_ENV: 'test' },
      secrets: new MemorySecretStore(),
    });
    running.settings.put('global', {
      ...DEFAULT_SETTINGS,
      logRetentionDays: 7,
      permissionRules: [{ effect: 'deny', tool: 'run_command', pattern: 'git push*' }],
    });
    running.db.client
      .prepare('INSERT INTO telemetry_logs(id,ts) VALUES(?,?)')
      .run('startup-expired', expired);
    await running.dispose();
    running = await createServices({
      dataDir,
      env: { NODE_ENV: 'test' },
      secrets: new MemorySecretStore(),
      retentionIntervalMs: 10,
    });
    expect(
      running.db.client.prepare('SELECT id FROM telemetry_logs WHERE id=?').get('startup-expired'),
    ).toBeUndefined();
    expect(running.settings.get('global')).toMatchObject({
      logRetentionDays: 7,
      permissionRules: [{ effect: 'deny', tool: 'run_command', pattern: 'git push*' }],
    });
    running.db.client
      .prepare('INSERT INTO telemetry_logs(id,ts) VALUES(?,?)')
      .run('scheduled-expired', expired);
    const db = running.db.client;
    await vi.waitFor(
      () => {
        expect(
          db.prepare('SELECT id FROM telemetry_logs WHERE id=?').get('scheduled-expired'),
        ).toBeUndefined();
      },
      { timeout: 2000, interval: 10 },
    );
  } finally {
    await running?.dispose();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
