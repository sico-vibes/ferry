import { expect, it, vi } from 'vitest';
import { sampleSettings } from '@ferry/shared/testing';
import type {
  CliConnection,
  CliConnectionKind,
  CliModelCapabilities,
  CliUsageSnapshot,
  ModelRef,
} from '@ferry/shared';
import type { CliTurnResult } from '@ferry/delegate';
import { CliTransportError } from '@ferry/delegate';
import { CliConnectionService } from '../src/cli-connections.js';
import {
  CliBroker,
  CLI_QUEUE_LIMIT,
  MANUAL_UNKNOWN_CAPACITY_INPUT_BOUND,
  cliInventorySnapshot,
  cliManualAdmission,
  cliModelInfo,
  cliOptionError,
  encodeOpenCodePrompt,
  mergeCliOption,
  resolveCliOption,
  unsupportedEffortsFor,
  type CliBrokerRequest,
} from '../src/cli-broker.js';
import type { FerryServices } from '../src/services.js';

const KINDS: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];

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

function model(
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

function connection(kind: CliConnectionKind, models: CliModelCapabilities[]): CliConnection {
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
  };
}

interface Harness {
  broker: CliBroker;
  service: CliConnectionService;
  store: Record<string, unknown>;
  events: { method: string; payload: unknown }[];
}

interface HarnessOptions {
  scan?: (kind: CliConnectionKind) => Promise<CliConnection>;
  authorizeSpend?: (connection: CliConnection, model: CliModelCapabilities) => boolean;
}

function harness(
  runner: (request: CliBrokerRequest) => Promise<CliTurnResult>,
  options: HarnessOptions = {},
): Harness {
  const store: Record<string, unknown> = { global: sampleSettings };
  const events: { method: string; payload: unknown }[] = [];
  const services = {
    settings: {
      get: (key: string) => store[key],
      put: (key: string, value: unknown) => {
        store[key] = value;
      },
    },
    clock: { now: () => new Date(1_000_000) },
    env: {},
  } as unknown as FerryServices;
  const scan =
    options.scan ??
    ((kind: CliConnectionKind) =>
      Promise.resolve(connection(kind, kind === 'opencode-cli' ? [] : [model(kind, 'model-a')])));
  const service = new CliConnectionService(
    services,
    (method, payload) => events.push({ method, payload }),
    {
      scan,
      usage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
      now: () => 1_000_000,
    },
  );
  const broker = new CliBroker(services, service, {
    runTurn: runner,
    ...(options.authorizeSpend ? { authorizeSpend: options.authorizeSpend } : {}),
  });
  return { broker, service, store, events };
}

function readyResult(request: CliBrokerRequest): CliTurnResult {
  return {
    text: 'Ready',
    toolCalls: [],
    usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
    responseModel: request.model.upstreamId,
  };
}

function codexRequest(
  service: CliConnectionService,
  signal: AbortSignal = new AbortController().signal,
): CliBrokerRequest {
  const codex = service.snapshot().find((entry) => entry.kind === 'codex-cli');
  if (!codex?.models[0]) throw new Error('missing codex model fixture');
  return {
    connection: codex,
    model: codex.models[0],
    options: { effort: null, speed: 'standard' },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal,
  };
}

it('exposes one CLI provider and its discovered models without a synthetic free route', async () => {
  const { broker, service } = harness((request) => Promise.resolve(readyResult(request)));
  await service.refresh();
  const providers = broker.providers();
  expect(providers.map((provider) => provider.id)).toEqual(KINDS);
  expect(providers.every((provider) => provider.kind === 'cli')).toBe(true);
  // Surface opt-ins default off, so the provider is not eligible even after discovery.
  expect(providers.some((provider) => provider.enabled)).toBe(false);
  const models = broker.models('codex-cli');
  expect(models).toHaveLength(1);
  const codexModel = models[0];
  expect(codexModel?.transport).toBe('codex_cli');
  expect(codexModel?.cliConnectionId).toBe('codex-cli');
  // Subscription capacity must never claim to be free.
  expect(codexModel?.free).toBe(false);
  expect(codexModel?.cliCapabilities?.upstreamId).toBe('model-a');
});

it('builds the same inventory from a pure cached snapshot', () => {
  const snapshot = [connection('codex-cli', [model('codex-cli', 'model-a')])];
  const inventory = cliInventorySnapshot(snapshot);
  expect(inventory.providers).toHaveLength(1);
  expect(inventory.models[0]?.ref).toBe('codex-cli/model-a');
});

it('never fabricates capacity: uses discovered limits or an explicit unknown state', () => {
  const unknown = cliModelInfo(connection('codex-cli', []), model('codex-cli', 'model-a'));
  expect(unknown.capacityKnown).toBe(false);
  const known = cliModelInfo(
    connection('codex-cli', []),
    model('codex-cli', 'model-a', { contextWindow: 200_000, maxOutput: 64_000 }),
  );
  expect(known.capacityKnown).toBe(true);
  expect(known.contextWindow).toBe(200_000);
  expect(known.maxOutput).toBe(64_000);
});

it('verifies with a real bounded generation and stores a bound receipt', async () => {
  const runner = vi.fn((request: CliBrokerRequest) => Promise.resolve(readyResult(request)));
  const { broker, service, events } = harness(runner);
  await service.refresh();
  const result = await broker.verify('codex-cli');
  expect(result.ok).toBe(true);
  expect(result.modelRef).toBe('codex-cli/model-a');
  expect(runner).toHaveBeenCalledTimes(1);
  const connectionNow = broker.connections().find((entry) => entry.kind === 'codex-cli');
  expect(connectionNow?.verify.state).toBe('verified');
  expect(connectionNow?.verify.modelRef).toBe('codex-cli/model-a');
  expect(connectionNow?.verify.receiptKey).toBeTruthy();
  expect(events.some((event) => event.method === 'cliConnections.updated')).toBe(true);
});

it('records a failed verification without claiming success', async () => {
  const { broker, service } = harness(() =>
    Promise.reject(new CliTransportError('authentication', 'not signed in')),
  );
  await service.refresh();
  const result = await broker.verify('codex-cli');
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/not signed in/);
  expect(broker.connections().find((entry) => entry.kind === 'codex-cli')?.verify.state).toBe(
    'failed',
  );
});

it('does not verify when discovery has no model for the connection', async () => {
  const { broker, service } = harness((request) => Promise.resolve(readyResult(request)));
  await service.refresh();
  const result = await broker.verify('opencode-cli');
  expect(result.ok).toBe(false);
  expect(result.modelRef).toBeNull();
});

it('refuses to verify metered billing without existing spending authorization', async () => {
  const runner = vi.fn((request: CliBrokerRequest) => Promise.resolve(readyResult(request)));
  const metered = model('opencode-cli', 'metered', { billing: 'metered' });
  const h = harness(runner, { scan: () => Promise.resolve(connection('opencode-cli', [metered])) });
  await h.service.refresh('opencode-cli');
  const explicit = await h.broker.verify('opencode-cli', metered.ref);
  expect(explicit.ok).toBe(false);
  expect(explicit.message).toMatch(/spending authorization/);
  // Default selection has no non-spending model, so it also refuses.
  const auto = await h.broker.verify('opencode-cli');
  expect(auto.ok).toBe(false);
  expect(runner).not.toHaveBeenCalled();
});

it('verifies metered billing only when spending is explicitly authorized', async () => {
  const runner = vi.fn((request: CliBrokerRequest) => Promise.resolve(readyResult(request)));
  const metered = model('opencode-cli', 'metered', { billing: 'metered' });
  const h = harness(runner, {
    scan: () => Promise.resolve(connection('opencode-cli', [metered])),
    authorizeSpend: () => true,
  });
  await h.service.refresh('opencode-cli');
  const result = await h.broker.verify('opencode-cli', metered.ref);
  expect(result.ok).toBe(true);
  expect(runner).toHaveBeenCalledTimes(1);
});

it('refuses Ferry credential verification before dispatch instead of substituting anonymous', async () => {
  const runner = vi.fn((request: CliBrokerRequest) => Promise.resolve(readyResult(request)));
  const go = model('opencode-cli', 'opencode-go/deepseek', { billing: 'included_subscription' });
  const h = harness(runner, { scan: () => Promise.resolve(connection('opencode-cli', [go])) });
  h.store.global = {
    ...sampleSettings,
    cliConnections: { 'opencode-cli': { credentialMode: 'ferry' } },
  };
  await h.service.refresh('opencode-cli');
  const result = await h.broker.verify('opencode-cli');
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/selected saved key/);
  expect(runner).not.toHaveBeenCalled();
});

it('immediately stales a verified receipt when the credential selection changes', async () => {
  const go = model('opencode-cli', 'opencode-go/deepseek', { billing: 'included_subscription' });
  const h = harness((request) => Promise.resolve(readyResult(request)), {
    scan: () => Promise.resolve(connection('opencode-cli', [go])),
  });
  await h.service.refresh('opencode-cli');
  expect((await h.broker.verify('opencode-cli')).ok).toBe(true);
  expect(h.service.snapshot().find((entry) => entry.kind === 'opencode-cli')?.verify.state).toBe(
    'verified',
  );
  const updated = h.service.update('opencode-cli', { credentialMode: 'ferry' });
  expect(updated.verify.state).toBe('stale');
  expect(
    h.events.some(
      (event) =>
        event.method === 'cliConnections.updated' &&
        (event.payload as CliConnection).verify.state === 'stale',
    ),
  ).toBe(true);
});

it('serializes one active generation per connection and drains the queue fairly', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const { broker, service } = harness(async (request) => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return readyResult(request);
  });
  await service.refresh();
  const request = codexRequest(service);
  const first = broker.run(request);
  const second = broker.run(request);
  await new Promise((resolve) => setImmediate(resolve));
  expect(peak).toBe(1);
  release();
  await Promise.all([first, second]);
  expect(peak).toBe(1);
});

it('rejects a generation when the connection backlog is full', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { broker, service } = harness(async (request) => {
    await gate;
    return readyResult(request);
  });
  await service.refresh();
  const request = codexRequest(service);
  const active = broker.run(request);
  const queued = Array.from({ length: CLI_QUEUE_LIMIT }, () => broker.run(request));
  await new Promise((resolve) => setImmediate(resolve));
  await expect(broker.run(request)).rejects.toThrow(/queued generations/);
  release();
  await Promise.all([active, ...queued]);
});

it('rejects a pre-aborted request before it consumes the slot', async () => {
  const runner = vi.fn((request: CliBrokerRequest) => Promise.resolve(readyResult(request)));
  const { broker, service } = harness(runner);
  await service.refresh();
  const controller = new AbortController();
  controller.abort(new CliTransportError('cancelled', 'user cancelled'));
  await expect(broker.run(codexRequest(service, controller.signal))).rejects.toThrow(/cancelled/);
  expect(runner).not.toHaveBeenCalled();
});

it('settles a queued cancellation promptly and continues FIFO when the active turn finishes', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const { broker, service } = harness(async (request) => {
    order.push(String(request.messages[0]?.content));
    await gate;
    return readyResult(request);
  });
  await service.refresh();
  const base = codexRequest(service);
  const active = broker.run({ ...base, messages: [{ role: 'user', content: 'active' }] });
  const controller = new AbortController();
  const cancelled = broker.run({
    ...base,
    messages: [{ role: 'user', content: 'cancelled' }],
    signal: controller.signal,
  });
  const follow = broker.run({ ...base, messages: [{ role: 'user', content: 'follow' }] });
  await new Promise((resolve) => setImmediate(resolve));
  // The active transport is still running; the queued waiter must reject without waiting for it.
  controller.abort(new CliTransportError('cancelled', 'user cancelled'));
  await expect(cancelled).rejects.toThrow(/cancelled/);
  expect(order).toEqual(['active']);
  release();
  await Promise.all([active, follow]);
  // The cancelled waiter was removed, so the next in line ran (FIFO preserved).
  expect(order).toEqual(['active', 'follow']);
});

it('times out a queued request without waiting for the active transport', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = vi.fn(async (request: CliBrokerRequest) => {
    await gate;
    return readyResult(request);
  });
  const { broker, service } = harness(runner);
  await service.refresh();
  const base = codexRequest(service);
  const active = broker.run(base);
  await new Promise((resolve) => setImmediate(resolve));
  // timeoutMs: 0 means the queue deadline is already reached.
  await expect(broker.run({ ...base, timeoutMs: 0 })).rejects.toThrow(/deadline/);
  release();
  await active;
  expect(runner).toHaveBeenCalledTimes(1);
});

it('encodes caller roles, tool call ids and real tool results without inventing output', () => {
  const prompt = encodeOpenCodePrompt(
    [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Read the file.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'FILE-BODY', tool_call_id: 'call_1' },
    ],
    [{ name: 'read', description: 'Read a file', parameters: {} }],
  );
  expect(prompt).toContain('[system]\nBe terse.');
  expect(prompt).toContain('[assistant]');
  expect(prompt).toContain('call_1');
  expect(prompt).toContain('[tool result for call_1]\nFILE-BODY');
  expect(prompt).toContain('read = ferry_tools_tool_0');
});

it('keeps raw effort tokens but reports advertised-unrunnable controls with a reason', () => {
  const cap = model('codex-cli', 'model-a', { efforts: ['low', 'high', 'ultra'] });
  const unsupported = unsupportedEffortsFor(cap);
  expect(Object.keys(unsupported)).toEqual(['ultra']);
  expect(Object.values(unsupported).join(' ')).toMatch(/bridge/);
  // The raw token stays in `efforts` for the UI.
  expect(cap.efforts).toContain('ultra');
});

it('rejects explicit unavailable/unsupported CLI options but accepts absent and null patches', () => {
  const cap = model('codex-cli', 'model-a', {
    efforts: ['low', 'high', 'ultra'],
    speeds: ['standard'],
  });
  const ref = cap.ref;
  expect(cliOptionError(ref, cap, { effort: 'ultra' })).toMatch(/unavailable/);
  expect(cliOptionError(ref, cap, { effort: 'max' })).toMatch(/not a supported effort/);
  expect(cliOptionError(ref, cap, { speed: 'fast' })).toMatch(/not a supported speed/);
  // Absent fields and an explicit null effort preserve/clear the override instead of failing.
  expect(cliOptionError(ref, cap, {})).toBeNull();
  expect(cliOptionError(ref, cap, { effort: null })).toBeNull();
  expect(cliOptionError(ref, cap, { effort: 'high', speed: 'standard' })).toBeNull();
});

it('merges CLI option patches preserving absent fields and clearing explicit null', () => {
  expect(mergeCliOption(undefined, { effort: 'high' })).toEqual({
    effort: 'high',
    speed: 'standard',
  });
  expect(mergeCliOption({ effort: 'high', speed: 'standard' }, { speed: 'standard' })).toEqual({
    effort: 'high',
    speed: 'standard',
  });
  expect(mergeCliOption({ effort: 'high', speed: 'standard' }, { effort: null })).toEqual({
    effort: null,
    speed: 'standard',
  });
});

it('stales a persisted verified receipt whose bound evidence is missing or changed', () => {
  const { broker, service } = harness((request) => Promise.resolve(readyResult(request)));
  // A legacy receipt with no fingerprint must not be trusted.
  service.applyVerification('codex-cli', {
    state: 'verified',
    modelRef: 'codex-cli/model-a' as ModelRef,
    checkedAt: '2026-01-01T00:00:00.000Z',
    message: null,
  });
  const connection = broker.connections().find((entry) => entry.kind === 'codex-cli');
  expect(connection?.verify.state).toBe('stale');
});

it('accumulates per-model verification receipts without forgetting earlier verified models', async () => {
  const runner = vi.fn((request: CliBrokerRequest) => Promise.resolve(readyResult(request)));
  const models = [model('codex-cli', 'model-a'), model('codex-cli', 'model-b')];
  const h = harness(runner, { scan: () => Promise.resolve(connection('codex-cli', models)) });
  await h.service.refresh('codex-cli');
  expect((await h.broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef)).ok).toBe(true);
  expect((await h.broker.verify('codex-cli', 'codex-cli/model-b' as ModelRef)).ok).toBe(true);
  const connectionNow = h.broker.connections().find((entry) => entry.kind === 'codex-cli');
  expect(Object.keys(connectionNow?.verify.modelReceipts ?? {}).sort()).toEqual([
    'codex-cli/model-a',
    'codex-cli/model-b',
  ]);
  // Per-model access truth is exposed on each ModelInfo row, not just a single global receipt.
  const snapshot = cliInventorySnapshot(h.broker.connections());
  expect(snapshot.models.find((entry) => entry.ref === 'codex-cli/model-a')?.verified).toBe(true);
  expect(snapshot.models.find((entry) => entry.ref === 'codex-cli/model-b')?.verified).toBe(true);
});

it('a failed check of a new model does not disable already-verified models', async () => {
  const runner = vi.fn((request: CliBrokerRequest) =>
    request.model.ref === 'codex-cli/model-a'
      ? Promise.reject(new CliTransportError('authentication', 'no access for model-a'))
      : Promise.resolve(readyResult(request)),
  );
  const models = [model('codex-cli', 'model-a'), model('codex-cli', 'model-b')];
  const h = harness(runner, { scan: () => Promise.resolve(connection('codex-cli', models)) });
  await h.service.refresh('codex-cli');
  expect((await h.broker.verify('codex-cli', 'codex-cli/model-b' as ModelRef)).ok).toBe(true);
  const failed = await h.broker.verify('codex-cli', 'codex-cli/model-a' as ModelRef);
  expect(failed.ok).toBe(false);
  const connectionNow = h.broker.connections().find((entry) => entry.kind === 'codex-cli');
  expect(connectionNow?.verify.state).toBe('verified');
  expect(connectionNow?.verify.modelReceipts?.['codex-cli/model-b' as ModelRef]).toBeTruthy();
  expect(
    cliInventorySnapshot(h.broker.connections()).models.find((m) => m.ref === 'codex-cli/model-b')
      ?.verified,
  ).toBe(true);
});

it('admits a realistic full unknown-capacity prompt and rejects an oversized one', () => {
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
  // No discovered context window / max output -> capacityKnown is false, but a realistic full Ferry
  // tool schema + system context must still dispatch under the transport policy bound.
  const unknown = model('codex-cli', 'm', { billing: 'included_subscription' });
  expect(unknown.contextWindow).toBeUndefined();
  expect(
    cliManualAdmission(verified, unknown, 'native', {
      inputTokens: MANUAL_UNKNOWN_CAPACITY_INPUT_BOUND - 1,
    }).ok,
  ).toBe(true);
  const oversized = cliManualAdmission(verified, unknown, 'native', {
    inputTokens: MANUAL_UNKNOWN_CAPACITY_INPUT_BOUND + 1,
  });
  expect(oversized.ok).toBe(false);
  expect(oversized.statusCode).toBe(400);
  expect(oversized.message).toMatch(/did not report a context window/);
  // A model with a known context window is not bounded by the unknown-capacity policy.
  const known = model('codex-cli', 'm', {
    contextWindow: 400_000,
    maxOutput: 64_000,
    billing: 'included_subscription',
  });
  expect(cliManualAdmission(verified, known, 'native', { inputTokens: 300_000 }).ok).toBe(true);
});

it('delegates option resolution to the shared explicit-null-stops resolver', () => {
  const cap = model('codex-cli', 'model-a', { efforts: ['low', 'high'], defaultEffort: 'low' });
  // conversation null stops fall-through instead of picking the lower profile High.
  expect(
    resolveCliOption(cap, {
      conversation: { effort: null, speed: 'standard' },
      profileDefault: { effort: 'high' },
    }),
  ).toEqual({ effort: 'low', speed: 'standard' });
  // a per-model explicit null stops before a connection default High.
  expect(
    resolveCliOption(cap, {
      connectionModelDefault: { effort: null },
      connectionDefault: { effort: 'high', speed: 'standard' },
    }),
  ).toEqual({ effort: 'low', speed: 'standard' });
  // absent partial effort inherits while an explicit speed wins.
  expect(
    resolveCliOption(cap, {
      conversation: { speed: 'fast' },
      profileDefault: { effort: 'high' },
      connectionDefault: { effort: null, speed: 'standard' },
    }),
  ).toEqual({ effort: 'high', speed: 'fast' });
});
