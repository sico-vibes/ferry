import { expect, it } from 'vitest';
import { sampleSettings } from '@ferry/shared/testing';
import type { CliConnection, CliConnectionKind, CliUsageSnapshot, ModelRef } from '@ferry/shared';
import type { CliAccountProbe, CliUsageRefresh } from '@ferry/delegate';
import { CliConnectionService, MODEL_TTL_MS, USAGE_TTL_MS } from '../src/cli-connections.js';
import type { FerryServices } from '../src/services.js';

const KINDS: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];

function usageFor(kind: CliConnectionKind): CliUsageSnapshot {
  if (kind === 'opencode-cli')
    return {
      connectionId: kind,
      accountKey: null,
      state: 'unavailable',
      source: 'cli',
      observedAt: null,
      staleAt: null,
      windows: [],
      note: 'OpenCode usage is observed by Ferry during generation.',
    };
  return {
    connectionId: kind,
    accountKey: null,
    state: 'available',
    source: 'fixture',
    observedAt: new Date(1_000_000).toISOString(),
    staleAt: null,
    windows: [
      {
        id: 'five_hour',
        label: 'five_hour',
        metric: 'percent',
        windowKind: 'five_hour',
        used: 50,
        limit: 100,
        remaining: 50,
        utilization: 0.5,
        resetAt: null,
      },
    ],
    note: null,
  };
}

function modelA(kind: CliConnectionKind, speeds: CliConnection['models'][number]['speeds']) {
  return {
    ref: `${kind}/model-a` as CliConnection['models'][number]['ref'],
    connectionId: kind,
    providerId: kind,
    upstreamId: 'model-a',
    upstreamProvider: null,
    name: 'Model A',
    efforts: ['low', 'high'],
    defaultEffort: 'low',
    speeds,
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing: 'included_subscription',
    hidden: false,
  } satisfies CliConnection['models'][number];
}

function connection(kind: CliConnectionKind): CliConnection {
  return {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: null,
    install: { installed: true, executable: kind, version: '1.0.0', installHint: '' },
    account: { state: 'signed_in', key: `${kind}:${'a'.repeat(24)}`, label: null, plan: null },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models: kind === 'codex-cli' ? [modelA(kind, ['standard', 'fast'])] : [],
    usage: usageFor(kind),
    lastChecked: null,
    discoveryMessage: null,
  };
}

/** A connection that already carries a successful verification receipt. */
function verifiedConnection(kind: CliConnectionKind): CliConnection {
  return {
    ...connection(kind),
    account: {
      state: 'signed_in',
      key: `${kind}:${'a'.repeat(24)}`,
      label: 'old@example.com',
      plan: 'pro',
    },
    verify: {
      state: 'verified',
      modelRef: `${kind}/model-a` as CliConnection['models'][number]['ref'],
      checkedAt: '2026-01-01T00:00:00.000Z',
      message: null,
    },
  };
}

function accountFor(kind: CliConnectionKind): CliAccountProbe {
  const account = connection(kind).account;
  return { state: account.state, key: account.key, label: account.label, plan: account.plan };
}

interface Harness {
  service: CliConnectionService;
  store: Record<string, unknown>;
  events: { method: string; payload: unknown }[];
  scanCalls: Record<CliConnectionKind, number>;
  usageCalls: Record<CliConnectionKind, number>;
  clock: { now: number };
}

interface HarnessOverrides {
  scan?: (kind: CliConnectionKind) => Promise<CliConnection>;
  usage?: (kind: CliConnectionKind, connection: CliConnection) => Promise<CliUsageRefresh>;
  /** Pre-populate the persisted cache (e.g. a verified receipt) before constructing the service. */
  seedConnections?: CliConnection[];
}

function harness(overrides: HarnessOverrides = {}): Harness {
  const store: Record<string, unknown> = { global: sampleSettings };
  if (overrides.seedConnections) store['cli-connections'] = overrides.seedConnections;
  const events: { method: string; payload: unknown }[] = [];
  const scanCalls = { 'codex-cli': 0, 'claude-code-cli': 0, 'opencode-cli': 0 };
  const usageCalls = { 'codex-cli': 0, 'claude-code-cli': 0, 'opencode-cli': 0 };
  const clock = { now: 1_000_000 };
  const services = {
    settings: {
      get: (key: string) => store[key],
      put: (key: string, value: unknown) => {
        store[key] = value;
      },
    },
    env: {},
  } as unknown as FerryServices;
  const scanImpl =
    overrides.scan ?? ((kind: CliConnectionKind) => Promise.resolve(connection(kind)));
  const usageImpl =
    overrides.usage ??
    ((kind: CliConnectionKind) =>
      Promise.resolve({ usage: usageFor(kind), account: accountFor(kind) }));
  const service = new CliConnectionService(
    services,
    (method, payload) => events.push({ method, payload }),
    {
      scan: (kind) => {
        scanCalls[kind] += 1;
        return scanImpl(kind);
      },
      usage: (kind, conn) => {
        usageCalls[kind] += 1;
        return usageImpl(kind, conn);
      },
      now: () => clock.now,
    },
  );
  return { service, store, events, scanCalls, usageCalls, clock };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function codex(h: Harness): CliConnection | undefined {
  return h.service.list().find((entry) => entry.kind === 'codex-cli');
}

it('returns an immediate three-connection snapshot before discovery completes', async () => {
  const { service } = harness();
  const snapshot = service.list();
  expect(snapshot.map((entry) => entry.kind)).toEqual(KINDS);
  expect(snapshot.every((entry) => entry.account.state === 'not_checked')).toBe(true);
  await service.settle();
  expect(service.peakConcurrency()).toBeLessThanOrEqual(2);
});

it('refreshes all connections, persists metadata and emits updates', async () => {
  const { service, store, events, scanCalls } = harness();
  const refreshed = await service.refresh();
  expect(refreshed.every((entry) => entry.install.installed)).toBe(true);
  expect(Array.isArray(store['cli-connections'])).toBe(true);
  expect(events.some((event) => event.method === 'cliConnections.updated')).toBe(true);
  expect(scanCalls).toEqual({ 'codex-cli': 1, 'claude-code-cli': 1, 'opencode-cli': 1 });
});

it('never runs more than two probes at once across overlapping calls', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maxActive = 0;
  const { service, scanCalls } = harness({
    scan: async (kind) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return connection(kind);
    },
  });
  const pending = service.refresh();
  await flush();
  expect(maxActive).toBe(2);
  expect(scanCalls['codex-cli']).toBe(1);
  expect(scanCalls['claude-code-cli']).toBe(1);
  expect(scanCalls['opencode-cli']).toBe(0);
  release();
  await pending;
  expect(scanCalls['opencode-cli']).toBe(1);
  expect(maxActive).toBeLessThanOrEqual(2);
  expect(service.peakConcurrency()).toBeLessThanOrEqual(2);
  expect(active).toBe(0);
});

it('singleflights concurrent scans of the same kind', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { service, scanCalls } = harness({
    scan: async (kind) => {
      await gate;
      return connection(kind);
    },
  });
  const first = service.refresh('codex-cli');
  const second = service.refresh('codex-cli');
  await flush();
  expect(scanCalls['codex-cli']).toBe(1);
  release();
  await Promise.all([first, second]);
  expect(service.peakConcurrency()).toBeLessThanOrEqual(2);
});

it('serializes an explicit full scan behind an in-flight usage probe', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const h = harness({
    scan: (kind) => {
      order.push(`scan:${kind}`);
      return Promise.resolve(connection(kind));
    },
    usage: (kind) => {
      order.push(`usage:${kind}`);
      return kind === 'codex-cli'
        ? gate.then(() => ({ usage: usageFor(kind), account: null }))
        : Promise.resolve({ usage: usageFor(kind), account: null });
    },
  });
  await h.service.refresh();
  order.length = 0;
  h.clock.now += USAGE_TTL_MS + 1;
  h.service.list();
  await flush();
  const pending = h.service.refresh('codex-cli');
  await flush();
  // The full scan must wait for the in-flight usage probe rather than probe the connection twice.
  expect(order).not.toContain('scan:codex-cli');
  release();
  await pending;
  expect(order.indexOf('scan:codex-cli')).toBeGreaterThan(order.indexOf('usage:codex-cli'));
  expect(h.service.peakConcurrency()).toBeLessThanOrEqual(2);
});

it('joins an in-flight full scan when a usage refresh is requested', async () => {
  let gated = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let usageCount = 0;
  const h = harness({
    scan: (kind) => (gated ? gate.then(() => connection(kind)) : Promise.resolve(connection(kind))),
    usage: (kind) => {
      usageCount += 1;
      return Promise.resolve({ usage: usageFor(kind), account: null });
    },
  });
  await h.service.refresh('codex-cli');
  gated = true;
  const pending = h.service.refresh('codex-cli');
  await flush();
  h.clock.now += USAGE_TTL_MS + 1;
  h.service.list();
  await flush();
  expect(usageCount).toBe(0);
  release();
  await pending;
  await h.service.settle();
  expect(usageCount).toBe(0);
  expect(h.service.peakConcurrency()).toBeLessThanOrEqual(2);
});

it('applies install/model and usage TTLs independently per connection', async () => {
  const { service, scanCalls, usageCalls, clock } = harness();
  await service.refresh();
  clock.now += MODEL_TTL_MS + 1;
  service.list();
  await service.settle();
  expect(scanCalls).toEqual({ 'codex-cli': 2, 'claude-code-cli': 2, 'opencode-cli': 2 });

  clock.now += MODEL_TTL_MS + 1;
  await service.refresh('codex-cli');
  service.list();
  await service.settle();
  // Refreshing Codex leaves the other connections' TTLs expired while its own stays fresh.
  expect(scanCalls['codex-cli']).toBe(3);
  expect(scanCalls['claude-code-cli']).toBe(3);
  expect(scanCalls['opencode-cli']).toBe(3);

  // A minute later only usage refreshes: no version detection and no model/list repeat.
  clock.now += USAGE_TTL_MS + 1;
  const scanBefore = { ...scanCalls };
  const usageBefore = { ...usageCalls };
  service.list();
  await service.settle();
  expect(scanCalls).toEqual(scanBefore);
  expect(usageCalls['codex-cli']).toBe(usageBefore['codex-cli'] + 1);
  expect(usageCalls['claude-code-cli']).toBe(usageBefore['claude-code-cli'] + 1);
  // Unsupported usage is not polled.
  expect(usageCalls['opencode-cli']).toBe(usageBefore['opencode-cli']);
});

it('forces a full scan on explicit refresh even within the TTL', async () => {
  const { service, scanCalls } = harness();
  await service.refresh();
  await service.refresh();
  expect(scanCalls).toEqual({ 'codex-cli': 2, 'claude-code-cli': 2, 'opencode-cli': 2 });
});

it('releases the probe permit and records failure when a probe rejects', async () => {
  const { service, scanCalls } = harness({
    scan: (kind) =>
      kind === 'codex-cli'
        ? Promise.reject(new Error('fixture boom secret'))
        : Promise.resolve(connection(kind)),
  });
  await service.refresh();
  const failed = service.list().find((entry) => entry.kind === 'codex-cli');
  expect(failed?.verify.state).toBe('failed');
  expect(failed?.discoveryMessage).toBeTruthy();
  // The queue is not wedged: another probe still runs after the rejection.
  const claude = await service.refresh('claude-code-cli');
  expect(claude.find((entry) => entry.kind === 'claude-code-cli')?.install.installed).toBe(true);
  expect(scanCalls['codex-cli']).toBe(1);
  expect(scanCalls['claude-code-cli']).toBe(2);
  expect(service.peakConcurrency()).toBeLessThanOrEqual(2);
});

it('preserves verification across an unchanged refresh and invalidates on account change', async () => {
  let fresh = connection('codex-cli');
  const h = harness({
    seedConnections: [verifiedConnection('codex-cli')],
    scan: () => Promise.resolve(fresh),
  });
  await h.service.refresh('codex-cli');
  expect(codex(h)?.verify.state).toBe('verified');
  await h.service.refresh('codex-cli');
  expect(codex(h)?.verify.state).toBe('verified');
  // Account identity change invalidates the receipt.
  fresh = { ...fresh, account: { ...fresh.account, key: `codex-cli:${'b'.repeat(24)}` } };
  await h.service.refresh('codex-cli');
  expect(codex(h)?.verify.state).toBe('unverified');
});

it('invalidates verification when the verified model is no longer available', async () => {
  const h = harness({
    seedConnections: [verifiedConnection('codex-cli')],
    scan: () => Promise.resolve({ ...connection('codex-cli'), models: [] }),
  });
  await h.service.refresh('codex-cli');
  expect(codex(h)?.verify.state).toBe('unverified');
});

it('applies authoritative usage account evidence without leaking stale identity', async () => {
  let account: CliAccountProbe | null = {
    state: 'signed_out',
    key: null,
    label: null,
    plan: null,
  };
  const h = harness({
    scan: () => Promise.resolve(verifiedConnection('codex-cli')),
    usage: (kind) => Promise.resolve({ usage: usageFor(kind), account }),
  });
  await h.service.refresh('codex-cli');
  expect(codex(h)?.verify.state).toBe('verified');

  h.clock.now += USAGE_TTL_MS + 1;
  h.service.list();
  await h.service.settle();
  expect(codex(h)?.account.state).toBe('signed_out');
  expect(codex(h)?.account.key).toBeNull();
  expect(codex(h)?.account.label).toBeNull();
  expect(codex(h)?.verify.state).toBe('unverified');

  // An unavailable/errored probe cannot vouch for a logout: identity is preserved.
  account = null;
  h.clock.now += USAGE_TTL_MS + 1;
  h.service.list();
  await h.service.settle();
  expect(codex(h)?.account.state).toBe('signed_out');

  // A new account replaces the whole identity (never the new key with the old label/plan).
  account = {
    state: 'signed_in',
    key: `codex-cli:${'c'.repeat(24)}`,
    label: 'new@example.com',
    plan: 'pro',
  };
  h.clock.now += USAGE_TTL_MS + 1;
  h.service.list();
  await h.service.settle();
  expect(codex(h)?.account.key).toBe(`codex-cli:${'c'.repeat(24)}`);
  expect(codex(h)?.account.label).toBe('new@example.com');
  expect(codex(h)?.account.plan).toBe('pro');
});

it('clears an explicit null effort while an absent patch preserves the override', async () => {
  const { service, store } = harness();
  await service.refresh();
  const effort = () =>
    (
      store.global as {
        cliConnections: Record<string, { defaultOptions: { effort: string | null } }>;
      }
    ).cliConnections['codex-cli']?.defaultOptions.effort;
  service.update('codex-cli', { defaultOptions: { effort: 'high' } });
  expect(effort()).toBe('high');
  service.update('codex-cli', { defaultOptions: { speed: 'fast' } });
  expect(effort()).toBe('high');
  service.update('codex-cli', { defaultOptions: { effort: null } });
  expect(effort()).toBeNull();
});

it('validates model membership plus supported effort and speed', async () => {
  const { service } = harness();
  await service.refresh();
  service.update('codex-cli', { defaultOptions: { effort: 'high', speed: 'fast' } });
  expect(() => service.update('codex-cli', { defaultOptions: { effort: 'ultra' } })).toThrow(
    /not a supported effort/,
  );
  const codexModel = 'codex-cli/model-a' as ModelRef;
  const ghostModel = 'codex-cli/ghost' as ModelRef;
  service.update('codex-cli', { modelDefaults: { [codexModel]: { effort: 'low' } } });
  expect(() =>
    service.update('codex-cli', { modelDefaults: { [codexModel]: { effort: 'max' } } }),
  ).toThrow(/not a supported effort/);
  expect(() =>
    service.update('codex-cli', { modelDefaults: { [ghostModel]: { effort: 'low' } } }),
  ).toThrow(/Unknown model/);

  const restricted = harness({
    scan: (kind) =>
      Promise.resolve(
        kind === 'codex-cli'
          ? { ...connection(kind), models: [modelA(kind, ['standard'])] }
          : connection(kind),
      ),
  });
  await restricted.service.refresh();
  expect(() =>
    restricted.service.update('codex-cli', { defaultOptions: { speed: 'fast' } }),
  ).toThrow(/not a supported speed/);
});
