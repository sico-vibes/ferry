import { afterEach, expect, it, vi } from 'vitest';
import { BUILTIN_PROFILES } from '@ferry/router';
import { sampleSettings } from '@ferry/shared/testing';
import {
  ModelRefSchema,
  ProviderIdSchema,
  SettingsSchema,
  type CliConnection,
  type CliConnectionKind,
  type ModelRef,
  type Profile,
} from '@ferry/shared';
import type { CliTurnResult } from '@ferry/delegate';
import {
  canonicalZenRef,
  getCliBroker,
  type CliBrokerRequest,
  type CliTurnRunner,
} from '../src/cli-broker.js';
import { getCliConnectionService } from '../src/cli-connections.js';
import { getGatewayController } from '../src/gateway.js';
import type { FerryServices } from '../src/services.js';
import { startHarness, textTurn, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });

const ZEN_ALIAS = ModelRefSchema.parse('opencode/big-pickle');
const ZEN_CANONICAL = canonicalZenRef('big-pickle');
const OPENCODE = ProviderIdSchema.parse('opencode');

const builtinProfile = BUILTIN_PROFILES[0];
if (!builtinProfile) throw new Error('Missing built-in profile fixture');

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  vi.useRealTimers();
});

function emptyUsage(kind: CliConnectionKind) {
  return {
    connectionId: kind,
    accountKey: null,
    state: 'unavailable' as const,
    source: 'cli',
    observedAt: null,
    staleAt: null,
    windows: [],
    note: null,
  };
}

function cliModel(
  id: string,
  upstreamProvider: string,
  billing: 'free' | 'included_subscription',
  overrides: Partial<CliConnection['models'][number]> = {},
): CliConnection['models'][number] {
  return {
    ref: `opencode-cli/${upstreamProvider}/${id}` as CliConnection['models'][number]['ref'],
    connectionId: 'opencode-cli',
    providerId: 'opencode-cli',
    upstreamId: `${upstreamProvider}/${id}`,
    upstreamProvider,
    name: `${upstreamProvider}/${id}`,
    efforts: ['low', 'high'],
    defaultEffort: null,
    speeds: ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    contextWindow: 200_000,
    maxOutput: 8_192,
    billing,
    hidden: false,
    ...overrides,
  };
}

function openCodeConnection(overrides: Partial<CliConnection> = {}): CliConnection {
  return {
    id: 'opencode-cli',
    kind: 'opencode-cli',
    providerId: 'opencode-cli',
    upstreamLabel: 'OpenCode Zen',
    install: { installed: true, executable: 'opencode', version: '1.18.35', installHint: '' },
    account: {
      state: 'signed_in',
      key: `opencode-cli:${'a'.repeat(24)}`,
      label: 'OpenCode',
      plan: null,
    },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models: [cliModel('big-pickle', 'opencode', 'free')],
    usage: emptyUsage('opencode-cli'),
    lastChecked: null,
    discoveryMessage: null,
    ...overrides,
  };
}

function ready(text: string, request: CliBrokerRequest): CliTurnResult {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 7, outputTokens: 3, cachedTokens: null, reasoningTokens: null },
    responseModel: request.model.upstreamId,
  };
}

const isVerify = (request: CliBrokerRequest): boolean =>
  request.messages.some(
    (message) =>
      typeof message.content === 'string' && message.content.includes('Reply with exactly Ready'),
  );

async function setup(): Promise<{ h: CoreHarness; calls: CliBrokerRequest[] }> {
  const connection = openCodeConnection();
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready(`ALIAS-OK:${request.model.ref}`, request));
  };
  harness = await startHarness({
    cliScan: (kind) =>
      Promise.resolve(
        kind === 'opencode-cli'
          ? connection
          : { ...openCodeConnection(), id: kind, kind, providerId: kind, models: [] },
      ),
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn: runner,
  });
  harness.services.settings.put('global', sampleSettings);
  return { h: harness, calls };
}

function putGlobal(services: FerryServices, patch: Record<string, unknown>): void {
  const current = services.settings.get('global');
  const base = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  services.settings.put('global', SettingsSchema.parse({ ...sampleSettings, ...base, ...patch }));
}

async function enableGatewaySurface(h: CoreHarness, ref: ModelRef): Promise<void> {
  const service = getCliConnectionService(h.services, () => undefined);
  await service.refresh('opencode-cli');
  service.update('opencode-cli', {
    surfaces: { native: false, gateway: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  const result = await getCliBroker(h.services, () => undefined).verify('opencode-cli', ref);
  expect(result.ok, result.message).toBe(true);
}

async function startGateway(h: CoreHarness, profileId: string) {
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey('zen-alias', profileId);
  const token = controller.issueInternalToken(created.key.id);
  const base = controller.status.url ?? '';
  return {
    controller,
    created,
    url: `${base}/v1/chat/completions`,
    modelsUrl: `${base}/v1/models`,
    headers: { 'x-ferry-internal-token': token, 'content-type': 'application/json' },
  };
}

function post(gw: { url: string; headers: Record<string, string> }, body: unknown) {
  return fetch(gw.url, { method: 'POST', headers: gw.headers, body: JSON.stringify(body) });
}

function zenProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    ...builtinProfile,
    id: 'profile_zen_alias' as Profile['id'],
    name: 'Zen Alias',
    allowedProviders: 'all',
    allowSubscriptionCli: false,
    allowedModelRefs: [ZEN_ALIAS],
    ...overrides,
  } as Profile;
}

it('Auto selects the canonical Zen route from a profile legacy alias and preserves the requested ref', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile();
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await post(gw, {
      model: 'ferry/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    const record = gw.controller.requests()[0];
    expect(record?.modelRef).toBe(ZEN_CANONICAL);
    expect(record?.requestedModel).toBe('ferry/auto');
    expect(record?.servedProviderId).toBe('opencode-cli');
  } finally {
    await gw.controller.stop();
  }
});

it('explicit legacy alias selection dispatches the canonical Zen route and lists only the alias', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const gw = await startGateway(h, 'none');
  gw.controller.updateKey(gw.created.key.id, { allowedModels: [ZEN_ALIAS] });
  try {
    const listed = (await (await fetch(gw.modelsUrl, { headers: gw.headers })).json()) as {
      data: { id: string }[];
    };
    const ids = listed.data.map((model) => model.id);
    expect(ids).toContain(ZEN_ALIAS);
    expect(ids).not.toContain(ZEN_CANONICAL);

    const response = await post(gw, {
      model: ZEN_ALIAS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    const record = gw.controller.requests()[0];
    expect(record?.modelRef).toBe(ZEN_CANONICAL);
    expect(record?.requestedModel).toBe(ZEN_ALIAS);
  } finally {
    await gw.controller.stop();
  }
});

it('blocks a wrong or different alias, a blocked provider and a disabled surface without running', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);

  // Wrong ref: the alias names a model the CLI never discovered.
  const wrong = await startGateway(h, 'none');
  wrong.controller.updateKey(wrong.created.key.id, {
    allowedModels: [ModelRefSchema.parse('opencode/not-discovered')],
  });
  try {
    const response = await post(wrong, {
      model: 'opencode/not-discovered',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  } finally {
    await wrong.controller.stop();
  }

  // A different alias of the same connection must not resolve to big-pickle.
  const different = await startGateway(h, 'none');
  different.controller.updateKey(different.created.key.id, {
    allowedModels: [ModelRefSchema.parse('opencode/other-model')],
  });
  try {
    const response = await post(different, {
      model: 'opencode/other-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  } finally {
    await different.controller.stop();
  }

  // A profile that excludes the opencode-cli provider cannot reach the alias route.
  const blocked = zenProfile({
    id: 'profile_blocked' as Profile['id'],
    allowedProviders: [ProviderIdSchema.parse('codex-cli')],
  });
  h.services.settings.put('profiles', [zenProfile(), blocked]);
  const providerBlocked = await startGateway(h, String(blocked.id));
  try {
    const response = await post(providerBlocked, {
      model: 'ferry/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  } finally {
    await providerBlocked.controller.stop();
  }

  expect(calls).toHaveLength(0);
});

it('rejects the alias when the Gateway surface is opted out for Zen CLI', async () => {
  const { h, calls } = await setup();
  // Migrated shared record with gateway explicitly off: the legacy flag must not bypass it.
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  const service = getCliConnectionService(h.services, () => undefined);
  await service.refresh('opencode-cli');
  service.update('opencode-cli', { surfaces: { native: true, gateway: false } });
  await getCliBroker(h.services, () => undefined).verify('opencode-cli', ZEN_CANONICAL);

  const profile = zenProfile();
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await post(gw, {
      model: 'ferry/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
  } finally {
    await gw.controller.stop();
  }
});

it('keeps an API-selected Zen ref on the API even when the OpenCode CLI is enabled for gateway use', async () => {
  const { h, calls } = await setup();
  // Zen transport stays API; the shared OpenCode CLI is opted in for gateway/general use.
  putGlobal(h.services, { opencodeZenTransport: 'api', zenCliMigratedToShared: true });
  const service = getCliConnectionService(h.services, () => undefined);
  await service.refresh('opencode-cli');
  service.update('opencode-cli', { surfaces: { native: true, gateway: true } });
  const legacy = h.services.catalog.models.find((model) => model.ref === ZEN_ALIAS);
  if (!legacy) throw new Error('Missing opencode/big-pickle catalog fixture');
  h.services.models.replace(OPENCODE, [{ ...legacy, apiAccessVerified: true }]);
  await h.rpc.providers.setEnabled(OPENCODE, true);
  (h.services.env as Record<string, string>).FERRY_PROVIDER_BASE_URL_OPENCODE =
    `${h.server.baseUrl}/v1`;
  await h.services.secrets.set(OPENCODE, 'zen-api-key');
  h.services.providerKeys.put({
    id: OPENCODE,
    providerId: OPENCODE,
    keyringRef: OPENCODE,
    createdAt: new Date().toISOString(),
  });
  h.server.setResponses([textTurn('api-served')]);

  const gw = await startGateway(h, 'none');
  gw.controller.updateKey(gw.created.key.id, { allowedModels: [ZEN_ALIAS] });
  try {
    const response = await post(gw, {
      model: ZEN_ALIAS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    // The standard API served it; no CLI generation ran and no CLI alias resolved.
    expect(calls).toHaveLength(0);
    expect(
      h.server.requests.filter((request) => request.url.includes('/chat/completions')),
    ).toHaveLength(1);
    const record = gw.controller.requests()[0];
    expect(record?.modelRef).toBe(ZEN_ALIAS);
    expect(record?.servedConnectionId ?? null).toBeNull();
    expect(getCliBroker(h.services, () => undefined).model(ZEN_ALIAS)).toBeUndefined();
  } finally {
    await gw.controller.stop();
  }
});

it('captures the exact upstream quota event id for an API completion', async () => {
  const { h } = await setup();
  h.server.setResponses([textTurn('quota-served')]);
  const gw = await startGateway(h, 'auto-free');
  try {
    const response = await post(gw, {
      model: 'ferry/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    const record = gw.controller.requests()[0];
    expect(typeof record?.upstreamUsageId).toBe('string');
    const rows = h.services.quota
      .queryUsage()
      .filter((usage) => usage.id === record?.upstreamUsageId);
    expect(rows).toHaveLength(1);
  } finally {
    await gw.controller.stop();
  }
});

it('gives simultaneous same-key API completions distinct quota event ids and counts both', async () => {
  const { h } = await setup();
  const gw = await startGateway(h, 'auto-free');
  try {
    h.server.setResponses([textTurn('one', { delayMs: 40 }), textTurn('two', { delayMs: 40 })]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const [first, second] = await Promise.all([
      post(gw, { model: 'ferry/auto', messages: [{ role: 'user', content: 'a' }] }),
      post(gw, { model: 'ferry/auto', messages: [{ role: 'user', content: 'b' }] }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { id?: string };
    const secondBody = (await second.json()) as { id?: string };
    // The client-facing response id must be unique per completion, not a Date.now() collision.
    expect(typeof firstBody.id).toBe('string');
    expect(typeof secondBody.id).toBe('string');
    expect(firstBody.id).not.toBe('');
    expect(secondBody.id).not.toBe('');
    expect(firstBody.id).not.toBe(secondBody.id);
    const records = gw.controller.requests();
    expect(records).toHaveLength(2);
    const ids = records
      .map((record) => record.upstreamUsageId)
      .filter((id): id is string => typeof id === 'string');
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const usageIds = new Set(h.services.quota.queryUsage().map((usage) => usage.id));
    for (const id of ids) expect(usageIds.has(id)).toBe(true);
  } finally {
    await gw.controller.stop();
  }
});

it('records no pre-existing API quota event id for a CLI completion', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile();
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const usageBefore = h.services.quota.queryUsage().length;
    const response = await post(gw, {
      model: 'ferry/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const record = gw.controller.requests()[0];
    expect(record?.upstreamUsageId ?? null).toBeNull();
    expect(h.services.quota.queryUsage().length).toBe(usageBefore);
  } finally {
    await gw.controller.stop();
  }
});

it('gives simultaneous same-key CLI completions distinct public response ids under a fixed clock', async () => {
  const { h } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile();
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const [first, second] = await Promise.all([
      post(gw, { model: 'ferry/auto', messages: [{ role: 'user', content: 'a' }] }),
      post(gw, { model: 'ferry/auto', messages: [{ role: 'user', content: 'b' }] }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { id?: string };
    const secondBody = (await second.json()) as { id?: string };
    expect(typeof firstBody.id).toBe('string');
    expect(typeof secondBody.id).toBe('string');
    expect(firstBody.id).not.toBe('');
    expect(secondBody.id).not.toBe('');
    expect(firstBody.id).not.toBe(secondBody.id);
  } finally {
    await gw.controller.stop();
  }
});

it('applies a saved legacy-alias profile effort on Auto through the canonical route', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile({
    cliDefaults: { [ZEN_ALIAS]: { effort: 'high', speed: 'standard' } },
  });
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await post(gw, {
      model: 'ferry/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    // The saved default kept its original `opencode/<id>` ref; it still reaches the exact route.
    expect(calls[0]?.options.effort).toBe('high');
  } finally {
    await gw.controller.stop();
  }
});

it('applies the exact saved legacy-alias default on a direct alias request', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile({
    cliDefaults: { [ZEN_ALIAS]: { effort: 'high', speed: 'standard' } },
  });
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  gw.controller.updateKey(gw.created.key.id, { allowedModels: [ZEN_ALIAS] });
  try {
    const response = await post(gw, {
      model: ZEN_ALIAS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    expect(calls[0]?.options.effort).toBe('high');
  } finally {
    await gw.controller.stop();
  }
});

it('lets an explicit request effort override a saved legacy-alias profile default', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile({
    cliDefaults: { [ZEN_ALIAS]: { effort: 'high', speed: 'standard' } },
  });
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await post(gw, {
      model: 'ferry/auto',
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.effort).toBe('low');
  } finally {
    await gw.controller.stop();
  }
});

it('never leaks a saved default from another model or provider into this route', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile({
    cliDefaults: {
      // A different upstream alias and a different canonical ref: neither is this route's default.
      [ModelRefSchema.parse('opencode/other-model')]: { effort: 'high', speed: 'standard' },
      [ModelRefSchema.parse('opencode-cli/opencode-go/deepseek')]: {
        effort: 'high',
        speed: 'standard',
      },
    },
  });
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await post(gw, {
      model: 'ferry/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    // big-pickle reports no default effort; an unrelated saved default must not apply.
    expect(calls[0]?.options.effort).toBeNull();
  } finally {
    await gw.controller.stop();
  }
});

it('admits a legacy alias on a broad key and preserves the raw requested ref in history', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const gw = await startGateway(h, 'none');
  try {
    const response = await post(gw, {
      model: ZEN_ALIAS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    const record = gw.controller.requests()[0];
    expect(record?.requestedModel).toBe(ZEN_ALIAS);
    expect(record?.modelRef).toBe(ZEN_CANONICAL);
  } finally {
    await gw.controller.stop();
  }
});

it('allows both explicit forms for a key permitting the alias and canonical with one listing row', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const gw = await startGateway(h, 'none');
  gw.controller.updateKey(gw.created.key.id, { allowedModels: [ZEN_ALIAS, ZEN_CANONICAL] });
  try {
    const listed = (await (await fetch(gw.modelsUrl, { headers: gw.headers })).json()) as {
      data: { id: string }[];
    };
    const ids = listed.data.map((model) => model.id);
    expect(ids.filter((id) => id === ZEN_CANONICAL)).toHaveLength(1);
    expect(ids).not.toContain(ZEN_ALIAS);

    const legacy = await post(gw, {
      model: ZEN_ALIAS,
      messages: [{ role: 'user', content: 'legacy' }],
    });
    expect(legacy.status).toBe(200);
    expect(calls.at(-1)?.model.ref).toBe(ZEN_CANONICAL);

    const canonical = await post(gw, {
      model: ZEN_CANONICAL,
      messages: [{ role: 'user', content: 'canonical' }],
    });
    expect(canonical.status).toBe(200);
    expect(calls.at(-1)?.model.ref).toBe(ZEN_CANONICAL);

    const records = gw.controller.requests();
    expect(
      records.some(
        (record) => record.requestedModel === ZEN_ALIAS && record.modelRef === ZEN_CANONICAL,
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) => record.requestedModel === ZEN_CANONICAL && record.modelRef === ZEN_CANONICAL,
      ),
    ).toBe(true);
  } finally {
    await gw.controller.stop();
  }
});

it('admits a canonical request against a legacy-only key without widening its policy', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const gw = await startGateway(h, 'none');
  gw.controller.updateKey(gw.created.key.id, { allowedModels: [ZEN_ALIAS] });
  try {
    const listed = (await (await fetch(gw.modelsUrl, { headers: gw.headers })).json()) as {
      data: { id: string }[];
    };
    const ids = listed.data.map((model) => model.id);
    expect(ids).toContain(ZEN_ALIAS);
    expect(ids).not.toContain(ZEN_CANONICAL);

    const response = await post(gw, {
      model: ZEN_CANONICAL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    expect(gw.controller.requests()[0]?.requestedModel).toBe(ZEN_CANONICAL);
  } finally {
    await gw.controller.stop();
  }
});

it('does not admit a wrong or different alias even on a broad key', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const gw = await startGateway(h, 'none');
  try {
    for (const ref of ['opencode/not-discovered', 'opencode/other-model']) {
      const response = await post(gw, {
        model: ref,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status, ref).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toHaveLength(0);
  } finally {
    await gw.controller.stop();
  }
});

it('keeps the old-alias profile default for an explicit legacy request after normalization', async () => {
  const { h, calls } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  await enableGatewaySurface(h, ZEN_CANONICAL);
  const profile = zenProfile({
    allowedModelRefs: undefined,
    cliDefaults: { [ZEN_ALIAS]: { effort: 'high', speed: 'standard' } },
  });
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await post(gw, {
      model: ZEN_ALIAS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(ZEN_CANONICAL);
    // The original requested alias (not the normalized canonical ref) resolves the saved default.
    expect(calls[0]?.options.effort).toBe('high');
    const record = gw.controller.requests()[0];
    expect(record?.requestedModel).toBe(ZEN_ALIAS);
    expect(record?.modelRef).toBe(ZEN_CANONICAL);
  } finally {
    await gw.controller.stop();
  }
});
