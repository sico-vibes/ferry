import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BUILTIN_PROFILES } from '@ferry/router';
import { sampleSettings } from '@ferry/shared/testing';
import { MemorySecretStore } from '@ferry/secrets';
import { CliTransportError } from '@ferry/delegate';
import type { CliTurnResult } from '@ferry/delegate';
import type {
  CliConnection,
  CliConnectionKind,
  CliModelCapabilities,
  CliUsageSnapshot,
  Message,
  MessagePart,
  ModelRef,
} from '@ferry/shared';
import {
  CliBroker,
  cliManualAdmission,
  getCliBroker,
  type CliBrokerRequest,
  type CliTurnRunner,
} from '../src/cli-broker.js';
import {
  CliConnectionService,
  bindCliEmit,
  getCliConnectionService,
  registerCliEmit,
} from '../src/cli-connections.js';
import { createSessionDependencies } from '../src/session-deps.js';
import { zenCliMode } from '../src/zen-cli.js';
import type { FerryServices } from '../src/services.js';
import { startHarness, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });

const builtinProfile = BUILTIN_PROFILES[0];
if (!builtinProfile) throw new Error('Missing built-in profile fixture');

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function emptyUsage(kind: CliConnectionKind): CliUsageSnapshot {
  return {
    connectionId: kind,
    accountKey: null,
    state: 'unavailable',
    source: 'cli',
    observedAt: null,
    staleAt: null,
    windows: [],
    note: null,
  };
}

function modelFor(
  kind: CliConnectionKind,
  id: string,
  overrides: Partial<CliModelCapabilities> = {},
): CliModelCapabilities {
  return {
    ref: `${kind}/${id}` as ModelRef,
    connectionId: kind,
    providerId: kind,
    upstreamId: id,
    upstreamProvider: null,
    name: `Model ${id}`,
    efforts: ['low', 'high'],
    defaultEffort: 'low',
    speeds: ['standard', 'fast'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing: 'included_subscription',
    hidden: false,
    ...overrides,
  };
}

function connection(
  kind: CliConnectionKind,
  models: CliModelCapabilities[],
  overrides: Partial<CliConnection> = {},
): CliConnection {
  return {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: null,
    install: { installed: true, executable: kind, version: '1.0.0', installHint: '' },
    account: { state: 'signed_in', key: `${kind}:${'a'.repeat(24)}`, label: null, plan: null },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models,
    usage: emptyUsage(kind),
    lastChecked: null,
    discoveryMessage: null,
    ...overrides,
  };
}

function ready(text: string, request: CliBrokerRequest): CliTurnResult {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
    responseModel: request.model.upstreamId,
  };
}

const isVerify = (request: CliBrokerRequest): boolean =>
  request.messages.some(
    (message) =>
      typeof message.content === 'string' && message.content.includes('Reply with exactly Ready'),
  );

/** Poll until the runner has received at least `count` non-verification requests. */
async function waitForCalls(calls: readonly CliBrokerRequest[], count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (calls.length < count) {
    if (Date.now() > deadline) throw new Error('runner was not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Controlled admission/queue barrier: yield the event loop a fixed number of macrotask turns so
 * every already-initiated `dispatch` drains its synchronous-free admission microtasks and lands in
 * the broker's fair queue (the parked waiter is pushed synchronously once `#acquire` is reached).
 * This replaces guessing with a wall-clock delay; it never needs the runner to be reached.
 */
async function settleAdmissions(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A settings/clock stub services object sufficient for capacity/eligibility/admission tests. */
function stubServices(
  store: Record<string, unknown>,
  clock: () => number,
  extras: Partial<FerryServices> = {},
): FerryServices {
  return {
    settings: {
      get: (key: string) => store[key],
      put: (key: string, value: unknown) => {
        store[key] = value;
      },
    },
    clock: { now: () => new Date(clock()) },
    env: {},
    ...extras,
  } as unknown as FerryServices;
}

function makeService(
  services: FerryServices,
  scan: (kind: CliConnectionKind) => Promise<CliConnection>,
  now: () => number,
  emit: (method: string, payload: unknown) => void = () => undefined,
): CliConnectionService {
  return new CliConnectionService(services, emit, {
    scan,
    usage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    now,
  });
}

/* ------------------------------- capacity guard -------------------------- */

it('persists a validated capacity block across restart and honors known/unknown reset', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  let now = 1_000_000;
  const services = stubServices(store, () => now);
  const codex = connection('codex-cli', [modelFor('codex-cli', 'model-a')]);
  let failure: 'none' | 'known' | 'unknown' = 'none';
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    if (failure === 'known')
      return Promise.reject(
        new CliTransportError('exhausted_capacity', 'account window exhausted', {
          resetAt: new Date(now + 5_000).toISOString(),
        }),
      );
    if (failure === 'unknown')
      return Promise.reject(
        new CliTransportError('exhausted_capacity', 'account window exhausted'),
      );
    return Promise.resolve(ready('done', request));
  };
  const scan = (): Promise<CliConnection> => Promise.resolve(codex);
  const service = makeService(services, scan, () => now);
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true, gateway: true } });
  expect((await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);

  // Known reset: block until the reported reset, then unblock (TTL only from the provider reset).
  failure = 'known';
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
  const afterKnown = calls.length;
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
  // The blocked dispatch never reached the runner (blocked before the prompt).
  expect(calls.length).toBe(afterKnown);
  // The non-secret block was persisted to Core settings.
  expect(Array.isArray(store['cli-capacity'])).toBe(true);
  expect((store['cli-capacity'] as unknown[]).length).toBeGreaterThan(0);

  // Restart: a new broker on the same settings store still sees the block.
  failure = 'none';
  const restartedService = makeService(services, scan, () => now);
  const restarted = new CliBroker(services, restartedService, { runTurn: runner });
  await restartedService.refresh('codex-cli');
  const beforeReset = calls.length;
  await expect(
    restarted.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
  expect(calls.length).toBe(beforeReset);

  // After the reported reset the same identity dispatches again.
  now += 6_000;
  await expect(
    restarted.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toBeTruthy();
  expect(calls.length).toBe(beforeReset + 1);
});

it('unknown-reset exhaustion blocks until an explicit successful check, not a timer', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  let now = 1_000_000;
  const services = stubServices(store, () => now);
  const codex = connection('codex-cli', [modelFor('codex-cli', 'model-a')]);
  let failure = false;
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    if (failure) return Promise.reject(new CliTransportError('exhausted_capacity', 'exhausted'));
    return Promise.resolve(ready('done', request));
  };
  const service = makeService(
    services,
    () => Promise.resolve(codex),
    () => now,
  );
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true, gateway: true } });
  await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef);
  failure = true;
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
  // A very large timer advance never unblocks an unknown-reset exhaustion.
  now += 10 * 365 * 24 * 60 * 60_000;
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
  // An explicit successful verification clears the unknown-reset block.
  failure = false;
  expect((await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toBeTruthy();
});

it('an actual account change clears only the correct old scope; timeouts/unsupported do not block', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const now = 1_000_000;
  const services = stubServices(store, () => now);
  let accountKey = `codex-cli:${'a'.repeat(24)}`;
  const scan = (): Promise<CliConnection> =>
    Promise.resolve(
      connection('codex-cli', [modelFor('codex-cli', 'model-a')], {
        account: { state: 'signed_in', key: accountKey, label: null, plan: null },
      }),
    );
  let failure: 'none' | 'exhausted' | 'timeout' | 'unsupported' = 'none';
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    if (failure === 'exhausted')
      return Promise.reject(new CliTransportError('exhausted_capacity', 'exhausted'));
    if (failure === 'timeout') return Promise.reject(new CliTransportError('timeout', 'slow'));
    if (failure === 'unsupported')
      return Promise.reject(new CliTransportError('unsupported_capability', 'nope'));
    return Promise.resolve(ready('done', request));
  };
  const service = makeService(services, scan, () => now);
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true, gateway: true } });
  await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef);

  // A cancellation/unsupported failure never becomes an account block.
  failure = 'unsupported';
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'unsupported_capability' });
  expect(broker.capacityBlocks()).toHaveLength(0);

  failure = 'exhausted';
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
  expect(broker.capacityBlocks().length).toBeGreaterThan(0);

  // A real account change invalidates the old receipt and clears only the old scope.
  failure = 'none';
  accountKey = `codex-cli:${'b'.repeat(24)}`;
  await service.refresh('codex-cli');
  expect((await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);
  // The account change cleared only the old scope's block.
  expect(broker.capacityBlocks()).toHaveLength(0);
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toBeTruthy();
});

/* ------------------------------ fast spend gate -------------------------- */

it('denies a possibly-billed fast included model without monetary authorization', () => {
  const verified: CliConnection = {
    ...connection('codex-cli', []),
    surfaces: { native: true, gateway: true },
    verify: {
      state: 'verified',
      modelRef: 'codex-cli/m' as ModelRef,
      checkedAt: new Date().toISOString(),
      message: null,
      receiptKey: 'k',
      modelReceipts: {
        ['codex-cli/m' as ModelRef]: { checkedAt: new Date().toISOString(), receiptKey: 'k' },
      },
    },
  };
  const included = modelFor('codex-cli', 'm', { billing: 'included_subscription' });
  expect(cliManualAdmission(verified, included, 'native', { speed: 'standard' }).ok).toBe(true);
  const fast = cliManualAdmission(verified, included, 'native', { speed: 'fast' });
  expect(fast.ok).toBe(false);
  expect(fast.statusCode).toBe(402);
  expect(
    cliManualAdmission(verified, included, 'native', {
      speed: 'fast',
      authorizeSpend: () => true,
    }).ok,
  ).toBe(true);
  // A *free* standard generation stays non-spending, but `fast` is not assumed free: the discovery
  // schema carries no separate evidence that the fast tier is zero-cost, so it must still be
  // authorized rather than charged implicitly at price zero.
  const free = modelFor('codex-cli', 'm', { billing: 'free' });
  expect(cliManualAdmission(verified, free, 'native', { speed: 'standard' }).ok).toBe(true);
  const freeFast = cliManualAdmission(verified, free, 'native', { speed: 'fast' });
  expect(freeFast.ok).toBe(false);
  expect(freeFast.statusCode).toBe(402);
  expect(
    cliManualAdmission(verified, free, 'native', {
      speed: 'fast',
      authorizeSpend: () => true,
    }).ok,
  ).toBe(true);
});

it('denies a would-succeed unauthorized free fast dispatch before the runner', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const services = stubServices(store, () => 1_000_000);
  const scan = (): Promise<CliConnection> =>
    Promise.resolve(
      connection('codex-cli', [modelFor('codex-cli', 'model-a', { billing: 'free' })]),
    );
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready('done', request));
  };
  const service = makeService(services, scan, () => 1_000_000);
  // The broker is built with the default closed spending authorization.
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true }, credentialMode: 'installed' });
  expect((await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
      optionOverride: { effort: null, speed: 'fast' },
    }),
  ).rejects.toMatchObject({ statusCode: 402 });
  // The would-succeed generation never ran; no implicit zero-cost charge was made.
  expect(calls).toHaveLength(0);
});

/* ------------------------------ eligible pool ---------------------------- */

it('builds the Auto funding pool: free first, included only when the profile opts in', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const services = stubServices(store, () => 1_000_000);
  const codex = connection('codex-cli', [
    modelFor('codex-cli', 'free', { billing: 'free' }),
    modelFor('codex-cli', 'included', { billing: 'included_subscription' }),
    modelFor('codex-cli', 'metered', { billing: 'metered' }),
    modelFor('codex-cli', 'unknown', { billing: 'unknown' }),
  ]);
  const runner: CliTurnRunner = (request) => Promise.resolve(ready('Ready', request));
  const service = makeService(
    services,
    () => Promise.resolve(codex),
    () => 1_000_000,
  );
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  const base = {
    ...builtinProfile,
    allowedProviders: 'all' as const,
    allowedModelRefs: undefined,
    allowSubscriptionCli: false,
  };
  // Not opted in yet -> nothing eligible.
  expect(broker.eligibleModels({ surface: 'native', profile: base })).toEqual([]);
  service.update('codex-cli', { surfaces: { native: true } });
  // Only the fundable models are verified; metered/unknown never become eligible regardless.
  for (const ref of ['free', 'included'] as const)
    expect((await broker.verify('codex-cli', `codex-cli/${ref}` as ModelRef)).ok).toBe(true);

  const noSub = broker.eligibleModels({ surface: 'native', profile: base });
  expect(noSub.map((model) => model.ref)).toEqual(['codex-cli/free']);
  const withSub = broker.eligibleModels({
    surface: 'native',
    profile: { ...base, allowSubscriptionCli: true },
  });
  // Free ranks ahead of included; metered/unknown are never in the pool.
  expect(withSub.map((model) => model.ref)).toEqual(['codex-cli/free', 'codex-cli/included']);
});

it('routes native Auto through the eligible installed-CLI pool, free ahead of included', async () => {
  const { h, service } = await nativeSetup({
    configure: (connections) => {
      connections['codex-cli'] = connection('codex-cli', [
        modelFor('codex-cli', 'free-a', { billing: 'free' }),
      ]);
      connections['claude-code-cli'] = connection('claude-code-cli', [
        modelFor('claude-code-cli', 'inc-a', { billing: 'included_subscription' }),
      ]);
    },
  });
  service.update('codex-cli', { surfaces: { native: true } });
  service.update('claude-code-cli', { surfaces: { native: true } });
  await service.refresh('codex-cli');
  await service.refresh('claude-code-cli');
  const broker = getCliBroker(h.services, () => undefined);
  expect((await broker.verify('codex-cli', 'codex-cli/free-a' as ModelRef)).ok).toBe(true);
  expect((await broker.verify('claude-code-cli', 'claude-code-cli/inc-a' as ModelRef)).ok).toBe(
    true,
  );

  const base = {
    ...builtinProfile,
    allowedProviders: 'all' as const,
    allowedModelRefs: undefined,
    allowSubscriptionCli: false,
  };
  const refs = createSessionDependencies(h.services, () => undefined, undefined, { profile: base })
    .gateway.resolveCandidates(base, 'plan')
    .map((model) => model.ref);
  // Free verified CLI capacity is eligible; the Included model is not without a profile opt-in.
  expect(refs).toContain('codex-cli/free-a');
  expect(refs).not.toContain('claude-code-cli/inc-a');

  const withSub = { ...base, allowSubscriptionCli: true };
  const subRefs = createSessionDependencies(h.services, () => undefined, undefined, {
    profile: withSub,
  })
    .gateway.resolveCandidates(withSub, 'plan')
    .map((model) => model.ref);
  const freeIndex = subRefs.indexOf('codex-cli/free-a' as ModelRef);
  const includedIndex = subRefs.indexOf('claude-code-cli/inc-a' as ModelRef);
  expect(includedIndex).toBeGreaterThanOrEqual(0);
  // Free CLI capacity leads the profile-approved Included capacity regardless of ranking.
  expect(freeIndex).toBeGreaterThanOrEqual(0);
  expect(freeIndex).toBeLessThan(includedIndex);
});

/* -------------------------- stable host emit target ---------------------- */

it('keeps a stable host emit target when the broker is constructed NoOp-first', () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const services = stubServices(store, () => 1_000_000);
  const events: string[] = [];
  const noop = (): void => undefined;
  // Construct with an inert emit first (as the Gateway controller does during registration).
  const service = getCliConnectionService(services, noop);
  getCliBroker(services, noop);
  // A real host registration later upgrades the target.
  registerCliEmit(services, (method) => events.push(method));
  service.applyVerification('codex-cli', {
    state: 'verified',
    modelRef: 'codex-cli/model-a' as ModelRef,
    checkedAt: new Date().toISOString(),
    message: null,
  });
  expect(events).toContain('cliConnections.updated');
  // A later NoOp construction never overwrites the real target.
  events.length = 0;
  bindCliEmit(services, noop);
  getCliBroker(services, noop);
  service.applyVerification('codex-cli', {
    state: 'unverified',
    modelRef: null,
    checkedAt: null,
    message: null,
  });
  expect(events).toContain('cliConnections.updated');
});

it('an explicit shared native/gateway false wins over the migrated legacy CLI flag', () => {
  const sharedOff = stubServices(
    {
      global: {
        ...sampleSettings,
        opencodeZenTransport: 'cli',
        zenCliMigratedToShared: true,
        cliConnections: {
          'opencode-cli': {
            native: false,
            gateway: false,
            credentialMode: 'installed',
            credentialProvider: null,
            defaultOptions: { effort: null, speed: 'standard' },
            modelDefaults: {},
          },
        },
      },
    },
    () => 1_000_000,
  );
  expect(zenCliMode(sharedOff)).toBe(false);
  // Before the one-time migration the legacy flag still selects both surfaces.
  const legacy = stubServices(
    {
      global: {
        ...sampleSettings,
        opencodeZenTransport: 'cli',
        zenCliMigratedToShared: false,
        cliConnections: {},
      },
    },
    () => 1_000_000,
  );
  expect(zenCliMode(legacy)).toBe(true);
  expect(zenCliMode(legacy, 'gateway')).toBe(true);
  // Surface-aware after migration: an explicit gateway-only opt-in never enables the native surface.
  const gatewayOnly = stubServices(
    {
      global: {
        ...sampleSettings,
        opencodeZenTransport: 'cli',
        zenCliMigratedToShared: true,
        cliConnections: {
          'opencode-cli': {
            native: false,
            gateway: true,
            credentialMode: 'installed',
            credentialProvider: null,
            defaultOptions: { effort: null, speed: 'standard' },
            modelDefaults: {},
          },
        },
      },
    },
    () => 1_000_000,
  );
  expect(zenCliMode(gatewayOnly)).toBe(false);
  expect(zenCliMode(gatewayOnly, 'gateway')).toBe(true);
});

/* ------------------------- credential-bound dispatch --------------------- */

interface NativeSetup {
  h: CoreHarness;
  calls: CliBrokerRequest[];
  connections: Record<CliConnectionKind, CliConnection>;
  service: CliConnectionService;
}

async function nativeSetup(options: {
  env?: NodeJS.ProcessEnv;
  configure?: (connections: Record<CliConnectionKind, CliConnection>) => void;
}): Promise<NativeSetup> {
  const connections: Record<CliConnectionKind, CliConnection> = {
    'codex-cli': connection('codex-cli', [modelFor('codex-cli', 'model-a')]),
    'claude-code-cli': connection('claude-code-cli', [modelFor('claude-code-cli', 'model-a')]),
    'opencode-cli': connection('opencode-cli', [
      modelFor('opencode-cli', 'opencode/zen-free', {
        upstreamProvider: 'opencode',
        billing: 'free',
      }),
      modelFor('opencode-cli', 'opencode-go/deepseek', {
        upstreamProvider: 'opencode-go',
        billing: 'included_subscription',
      }),
    ]),
  };
  options.configure?.(connections);
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready('ok', request));
  };
  harness = await startHarness({
    cliScan: (kind) => Promise.resolve(connections[kind]),
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn: runner,
    ...(options.env ? { env: options.env } : {}),
  });
  const service = getCliConnectionService(harness.services, () => undefined);
  return { h: harness, calls, connections, service };
}

it('uses the saved Ferry Zen key in ferry mode and binds a non-null credential fingerprint', async () => {
  const { h, service } = await nativeSetup({});
  const secrets = new MemorySecretStore();
  await secrets.set('opencode-zen-ref', 'zen-secret-value');
  (h.services as { secrets: FerryServices['secrets'] }).secrets = secrets;
  h.services.providerKeyEntries.put({
    id: 'opencode-zen',
    providerId: 'opencode',
    keyId: 'opencode-zen',
    keyringRef: 'opencode-zen-ref',
    label: 'Zen',
    position: 0,
    enabled: true,
    status: 'ok',
    lastError: null,
    cooldownUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  service.update('opencode-cli', {
    surfaces: { native: true, gateway: true },
    credentialMode: 'ferry',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  const broker = getCliBroker(h.services, () => undefined);
  const result = await broker.verify('opencode-cli', 'opencode-cli/opencode/zen-free' as ModelRef);
  expect(result.ok, result.message).toBe(true);
  // The verification generation received the memory-only saved key in ferry mode.
  const zen = broker.connections().find((entry) => entry.kind === 'opencode-cli');
  expect(zen?.verify.modelReceipts?.['opencode-cli/opencode/zen-free' as ModelRef]).toBeTruthy();
});

it('anonymous free Zen verifies with a null account but Go included does not', async () => {
  const { h, service } = await nativeSetup({
    configure: (connections) => {
      connections['opencode-cli'] = connection('opencode-cli', connections['opencode-cli'].models, {
        account: { state: 'not_checked', key: null, label: null, plan: null },
      });
    },
  });
  service.update('opencode-cli', {
    surfaces: { native: true, gateway: true },
    credentialMode: 'anonymous',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  const broker = getCliBroker(h.services, () => undefined);
  const zenRef = 'opencode-cli/opencode/zen-free' as ModelRef;
  // Anonymous free Zen verifies and dispatches keyless (no signed-in account key).
  expect((await broker.verify('opencode-cli', zenRef)).ok).toBe(true);
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: zenRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toBeTruthy();
  // Genuine keyless installed Zen access is admitted too.
  const zen = broker.model(zenRef);
  if (!zen) throw new Error('missing zen model');
  expect(
    cliManualAdmission(zen.connection, zen.model, 'native', {
      credentialMode: 'installed',
      credentialProvider: 'opencode',
    }).ok,
  ).toBe(true);
  // A Go account/provider never proves keyless Zen access.
  expect(
    cliManualAdmission(zen.connection, zen.model, 'native', {
      credentialMode: 'installed',
      credentialProvider: 'opencode-go',
    }).statusCode,
  ).toBe(401);
  // The Go upstream keeps its own installed source (verifies), but an unsigned included model is
  // never admitted keyless.
  const goRef = 'opencode-cli/opencode-go/deepseek' as ModelRef;
  expect((await broker.verify('opencode-cli', goRef)).ok).toBe(true);
  const go = broker.model(goRef);
  if (!go) throw new Error('missing go model');
  expect(
    cliManualAdmission(go.connection, go.model, 'native', {
      credentialMode: 'anonymous',
      credentialProvider: 'opencode-go',
    }).statusCode,
  ).toBe(401);
});

it('keeps mixed free Zen and Go included buckets independent across an exhaustion block', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-native-mixed-'));
  try {
    const dataHome = join(root, 'xdg');
    await mkdir(join(dataHome, 'opencode'), { recursive: true });
    await writeFile(
      join(dataHome, 'opencode', 'auth.json'),
      JSON.stringify({
        opencode: { type: 'api', key: 'zen-key' },
        'opencode-go': { type: 'api', key: 'go-key' },
      }),
      'utf8',
    );
    const { h, service } = await nativeSetup({ env: { XDG_DATA_HOME: dataHome } });
    service.update('opencode-cli', {
      surfaces: { native: true, gateway: true },
      credentialMode: 'installed',
      credentialProvider: null,
    });
    await service.refresh('opencode-cli');
    // Verify the Go included model; then make dispatch fail exhausted for Go only.
    let failGo = false;
    const runner: CliTurnRunner = (request) => {
      if (isVerify(request)) return Promise.resolve(ready('Ready', request));
      if (failGo && request.model.upstreamProvider === 'opencode-go')
        return Promise.reject(new CliTransportError('exhausted_capacity', 'go exhausted'));
      return Promise.resolve(ready('ok', request));
    };
    const broker = new CliBroker(h.services, service, { runTurn: runner });
    const zenRef = 'opencode-cli/opencode/zen-free' as ModelRef;
    const goRef = 'opencode-cli/opencode-go/deepseek' as ModelRef;
    expect((await broker.verify('opencode-cli', zenRef)).ok).toBe(true);
    expect((await broker.verify('opencode-cli', goRef)).ok).toBe(true);
    failGo = true;
    await expect(
      broker.dispatch({
        surface: 'native',
        modelRef: goRef,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
    // The Go exhaustion does not block the independent Zen free bucket.
    await expect(
      broker.dispatch({
        surface: 'native',
        modelRef: zenRef,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

/* --------------------------- producer metadata --------------------------- */

it('returns dispatch-captured producer metadata and preserves it across an account change', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const services = stubServices(store, () => 1_000_000);
  let accountKey = `codex-cli:${'a'.repeat(24)}`;
  const scan = (): Promise<CliConnection> =>
    Promise.resolve(
      connection('codex-cli', [modelFor('codex-cli', 'model-a')], {
        account: { state: 'signed_in', key: accountKey, label: null, plan: null },
      }),
    );
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    // Simulate an account change while the generation is in flight.
    accountKey = `codex-cli:${'b'.repeat(24)}`;
    return Promise.resolve(ready('hello', request));
  };
  const service = makeService(services, scan, () => 1_000_000);
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true } });
  await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef);
  const dispatch = await broker.dispatch({
    surface: 'native',
    modelRef: 'codex-cli/model-a' as ModelRef,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
  });
  // The producer identity is the pre-await account (A), never the post-await current account (B).
  expect(dispatch.accountKey).toBe(`codex-cli:${'a'.repeat(24)}`);
  expect(dispatch.connection.kind).toBe('codex-cli');
  expect(dispatch.model.ref).toBe('codex-cli/model-a');
});

it('runNativeCliStep returns dispatch-captured producer metadata on the native step', async () => {
  const { h, service } = await nativeSetup({});
  const ref = 'codex-cli/model-a' as ModelRef;
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true } });
  const broker = getCliBroker(h.services, () => undefined);
  expect((await broker.verify('codex-cli', ref)).ok).toBe(true);
  const model = broker.models('codex-cli').find((entry) => entry.ref === ref);
  if (!model) throw new Error('missing cli model');
  const profile = { ...builtinProfile };
  const runtime = createSessionDependencies(h.services, () => undefined, undefined, { profile });
  const controller = new AbortController();
  const message: Message = {
    id: 'msg_producer' as Message['id'],
    sessionId: 'sess_producer' as Message['sessionId'],
    role: 'user',
    createdAt: new Date().toISOString(),
    modelRef: null,
    parts: [{ type: 'text', id: 'part_producer' as MessagePart['id'], text: 'hi' }],
  };
  const step = await runtime.gateway.streamStep(
    {
      model,
      system: 'You are Ferry.',
      messages: [message],
      tools: [],
      signal: controller.signal,
      onDelta: () => undefined,
      modelHints: { toolProtocol: 'native', editFormat: 'search_replace' },
    },
    controller.signal,
  );
  const producer = (
    step as {
      producer?: {
        modelRef: string;
        providerId: string;
        connectionId: string;
        accountKey: string | null;
        requestedModelRef: string;
      };
    }
  ).producer;
  expect(producer?.modelRef).toBe(ref);
  expect(producer?.providerId).toBe('codex-cli');
  expect(producer?.connectionId).toBe('codex-cli');
  expect(producer?.requestedModelRef).toBe(ref);
  expect(producer?.accountKey).toBe(`codex-cli:${'a'.repeat(24)}`);
});

/* ------------------- known account-window exhaustion --------------------- */

function windowUsage(remaining: number): CliUsageSnapshot {
  return {
    connectionId: 'codex-cli',
    accountKey: null,
    state: 'available',
    source: 'cli',
    observedAt: null,
    staleAt: null,
    windows: [
      {
        id: 'codex:primary',
        label: 'Codex',
        metric: 'percent',
        windowKind: 'five_hour',
        used: 100 - remaining,
        limit: 100,
        remaining,
        utilization: (100 - remaining) / 100,
        resetAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    note: null,
  };
}

it('blocks a known-exhausted included account window before Verify and dispatch', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const services = stubServices(store, () => 1_000_000);
  let usage = windowUsage(0);
  const scan = (): Promise<CliConnection> =>
    Promise.resolve(connection('codex-cli', [modelFor('codex-cli', 'model-a')], { usage }));
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready('done', request));
  };
  const service = makeService(services, scan, () => 1_000_000);
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true } });

  // A known-exhausted snapshot blocks Verify too (no silent overage/credit use), runner not called.
  const verifyBlocked = await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef);
  expect(verifyBlocked.ok).toBe(false);
  expect(verifyBlocked.message).toMatch(/exhausted/i);
  expect(calls).toHaveLength(0);

  // A fresh usable snapshot admits Verify.
  usage = windowUsage(90);
  await service.refresh('codex-cli');
  expect((await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);
  expect(calls).toHaveLength(0);

  // Flipping back to exhausted blocks dispatch before the runner (even though it would succeed).
  usage = windowUsage(0);
  await service.refresh('codex-cli');
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity', resetAt: '2026-01-02T00:00:00.000Z' });
  expect(calls).toHaveLength(0);

  // Usable evidence again admits dispatch.
  usage = windowUsage(50);
  await service.refresh('codex-cli');
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toBeTruthy();
  expect(calls).toHaveLength(1);
});

it('supersedes an exhausted account window once its reported reset has elapsed', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  // The injected clock starts after the window's reported reset: the cached zero snapshot is stale.
  let now = Date.parse('2026-01-02T00:00:01.000Z');
  const services = stubServices(store, () => now);
  const exhausted = (): CliConnection =>
    connection('codex-cli', [modelFor('codex-cli', 'model-a')], {
      usage: {
        connectionId: 'codex-cli',
        accountKey: `codex-cli:${'a'.repeat(24)}`,
        state: 'available',
        source: 'cli',
        observedAt: null,
        staleAt: null,
        windows: [
          {
            id: 'codex:primary',
            label: 'Codex',
            metric: 'percent',
            windowKind: 'five_hour',
            used: 100,
            limit: 100,
            remaining: 0,
            utilization: 1,
            resetAt: '2026-01-02T00:00:00.000Z',
          },
        ],
        note: null,
      },
    });
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready('done', request));
  };
  const service = makeService(
    services,
    () => Promise.resolve(exhausted()),
    () => now,
  );
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true } });
  // The elapsed window no longer blocks verification either.
  expect((await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);
  // At/after the reported reset the elapsed window no longer blocks; the real generation decides.
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toBeTruthy();
  expect(calls).toHaveLength(1);

  // A window whose reset is still in the future keeps blocking.
  now = Date.parse('2026-01-01T23:59:00.000Z');
  await service.refresh('codex-cli');
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'exhausted_capacity' });
  expect(calls).toHaveLength(1);
});

it('never blocks the replacement account on a snapshot bound to a different account', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const services = stubServices(store, () => now);
  const otherAccount: CliConnection = connection('codex-cli', [modelFor('codex-cli', 'model-a')], {
    account: { state: 'signed_in', key: `codex-cli:${'b'.repeat(24)}`, label: null, plan: null },
    usage: {
      connectionId: 'codex-cli',
      // The cached zero snapshot belongs to the previous account A, not the current B.
      accountKey: `codex-cli:${'a'.repeat(24)}`,
      state: 'available',
      source: 'cli',
      observedAt: null,
      staleAt: null,
      windows: [
        {
          id: 'codex:primary',
          label: 'Codex',
          metric: 'percent',
          windowKind: 'five_hour',
          used: 100,
          limit: 100,
          remaining: 0,
          utilization: 1,
          resetAt: '2026-06-02T00:00:00.000Z',
        },
      ],
      note: null,
    },
  });
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready('done', request));
  };
  const service = makeService(
    services,
    () => Promise.resolve(otherAccount),
    () => now,
  );
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true } });
  expect((await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: 'codex-cli/model-a' as ModelRef,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toBeTruthy();
  expect(calls).toHaveLength(1);
});

/* ----------------------- queue revalidation ------------------------------ */

it('rejects a queued request when the surface is opted out before it runs', async () => {
  const store: Record<string, unknown> = { global: sampleSettings };
  const services = stubServices(store, () => 1_000_000);
  const scan = (): Promise<CliConnection> =>
    Promise.resolve(connection('codex-cli', [modelFor('codex-cli', 'model-a')]));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = async (request) => {
    if (isVerify(request)) return ready('Ready', request);
    calls.push(request);
    if (calls.length === 1) await gate;
    return ready('done', request);
  };
  const service = makeService(services, scan, () => 1_000_000);
  const broker = new CliBroker(services, service, { runTurn: runner });
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true } });
  await broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef);
  const request = () => ({
    surface: 'native' as const,
    modelRef: 'codex-cli/model-a' as ModelRef,
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
  });
  const first = broker.dispatch(request());
  await waitForCalls(calls, 1);
  const second = broker.dispatch(request());
  await settleAdmissions();
  // The operator opts the surface out while the second request is parked.
  service.update('codex-cli', { surfaces: { native: false } });
  release();
  await expect(first).resolves.toBeTruthy();
  await expect(second).rejects.toThrow(/opted out/);
  // The second request never reached the runner.
  expect(calls).toHaveLength(1);
});

it('rejects a queued request when the selected credential source changes before it runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-native-queue-'));
  try {
    const dataHome = join(root, 'xdg');
    await mkdir(join(dataHome, 'opencode'), { recursive: true });
    const authPath = join(dataHome, 'opencode', 'auth.json');
    const writeAuth = (goKey: string): Promise<void> =>
      writeFile(
        authPath,
        JSON.stringify({
          opencode: { type: 'api', key: 'zen-key' },
          'opencode-go': { type: 'api', key: goKey },
        }),
        'utf8',
      );
    await writeAuth('go-key-1');
    const { h, service } = await nativeSetup({ env: { XDG_DATA_HOME: dataHome } });
    service.update('opencode-cli', {
      surfaces: { native: true, gateway: true },
      credentialMode: 'installed',
      credentialProvider: null,
    });
    await service.refresh('opencode-cli');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: CliBrokerRequest[] = [];
    const runner: CliTurnRunner = async (request) => {
      if (isVerify(request)) return ready('Ready', request);
      calls.push(request);
      if (calls.length === 1) await gate;
      return ready('done', request);
    };
    const broker = new CliBroker(h.services, service, { runTurn: runner });
    const goRef = 'opencode-cli/opencode-go/deepseek' as ModelRef;
    expect((await broker.verify('opencode-cli', goRef)).ok).toBe(true);
    const request = () => ({
      surface: 'native' as const,
      modelRef: goRef,
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    });
    const first = broker.dispatch(request());
    await waitForCalls(calls, 1);
    const second = broker.dispatch(request());
    await settleAdmissions();
    // The Go credential rotates while the second request is parked.
    await writeAuth('go-key-2');
    release();
    await expect(first).resolves.toBeTruthy();
    await expect(second).rejects.toMatchObject({ kind: 'authentication' });
    expect(calls).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

/* ------------------- provider-specific receipt binding ------------------- */

it('stales only the rotated upstream and never reuses another provider proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-native-bind-'));
  try {
    const dataHome = join(root, 'xdg');
    await mkdir(join(dataHome, 'opencode'), { recursive: true });
    const authPath = join(dataHome, 'opencode', 'auth.json');
    const writeAuth = (key: string): Promise<void> =>
      writeFile(
        authPath,
        JSON.stringify({
          opencode: { type: 'api', key: 'zen-key' },
          'opencode-go': { type: 'api', key },
        }),
        'utf8',
      );
    await writeAuth('go-key-1');
    const { h, service } = await nativeSetup({ env: { XDG_DATA_HOME: dataHome } });
    service.update('opencode-cli', {
      surfaces: { native: true, gateway: true },
      credentialMode: 'installed',
      credentialProvider: null,
    });
    await service.refresh('opencode-cli');
    const broker = new CliBroker(h.services, service, {
      runTurn: (request) => Promise.resolve(ready('ok', request)),
    });
    const zenRef = 'opencode-cli/opencode/zen-free' as ModelRef;
    const goRef = 'opencode-cli/opencode-go/deepseek' as ModelRef;
    expect((await broker.verify('opencode-cli', zenRef)).ok).toBe(true);
    expect((await broker.verify('opencode-cli', goRef)).ok).toBe(true);
    // The connection-level account key comes from the Zen record and is unchanged by a Go rotation.
    const accountKeyBefore = broker.connections().find((e) => e.kind === 'opencode-cli')
      ?.account.key;
    await writeAuth('go-key-2');
    await service.refresh('opencode-cli');
    expect(broker.connections().find((e) => e.kind === 'opencode-cli')?.account.key).toBe(
      accountKeyBefore,
    );
    // The Go receipt's bound evidence no longer matches -> dispatch rejects before the runner.
    await expect(
      broker.dispatch({
        surface: 'native',
        modelRef: goRef,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'authentication' });
    // The Zen proof is untouched: the Go rotation did not stale it.
    await expect(
      broker.dispatch({
        surface: 'native',
        modelRef: zenRef,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('rejects a verification whose credential source changes during the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-native-verify-'));
  try {
    const dataHome = join(root, 'xdg');
    await mkdir(join(dataHome, 'opencode'), { recursive: true });
    const authPath = join(dataHome, 'opencode', 'auth.json');
    const writeAuth = (key: string): Promise<void> =>
      writeFile(
        authPath,
        JSON.stringify({
          opencode: { type: 'api', key: 'zen-key' },
          'opencode-go': { type: 'api', key },
        }),
        'utf8',
      );
    await writeAuth('go-key-1');
    const { h, service } = await nativeSetup({ env: { XDG_DATA_HOME: dataHome } });
    service.update('opencode-cli', {
      surfaces: { native: true, gateway: true },
      credentialMode: 'installed',
      credentialProvider: null,
    });
    await service.refresh('opencode-cli');
    const runner: CliTurnRunner = async (request) => {
      if (isVerify(request)) {
        // Rotate the credential mid-verification.
        await writeAuth('go-key-2');
        return ready('Ready', request);
      }
      return ready('ok', request);
    };
    const broker = new CliBroker(h.services, service, { runTurn: runner });
    const result = await broker.verify(
      'opencode-cli',
      'opencode-cli/opencode-go/deepseek' as ModelRef,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/changed during verification/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
