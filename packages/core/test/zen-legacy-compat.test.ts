import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '@ferry/shared';
import type { CliTurnResult } from '@ferry/delegate';
import { CliTransportError } from '@ferry/delegate';
import type { Profile } from '@ferry/shared';
import {
  canonicalZenRef,
  getCliBroker,
  legacyZenAliasId,
  type CliBrokerRequest,
  type CliTurnRunner,
} from '../src/cli-broker.js';
import { getCliConnectionService } from '../src/cli-connections.js';
import { verifyZenCli, zenCliMode, zenCliStatus } from '../src/zen-cli.js';
import type { FerryServices } from '../src/services.js';
import { startHarness, waitFor, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });

const LEGACY = ModelRefSchema.parse('opencode/big-pickle');
const CANONICAL = ModelRefSchema.parse(canonicalZenRef('big-pickle'));
const GO_CANONICAL = ModelRefSchema.parse('opencode-cli/opencode-go/deepseek-v4.1-flash');
const OPENCODE = ProviderIdSchema.parse('opencode');

const builtinProfile = BUILTIN_PROFILES[0];
if (!builtinProfile) throw new Error('Missing built-in profile fixture');

let harness: CoreHarness | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

/** Write an OpenCode auth store under a private XDG data home, never the real one. */
async function openCodeAuthHome(records: Record<string, { type: string; key?: string }>) {
  const root = await mkdtemp(join(tmpdir(), 'ferry-zen-legacy-'));
  tempDirs.push(root);
  const dataHome = join(root, 'xdg');
  await mkdir(join(dataHome, 'opencode'), { recursive: true });
  await writeFile(join(dataHome, 'opencode', 'auth.json'), JSON.stringify(records), 'utf8');
  return dataHome;
}

function putGlobal(services: FerryServices, patch: Record<string, unknown>): void {
  const current = services.settings.get('global');
  const base = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  services.settings.put('global', SettingsSchema.parse({ ...sampleSettings, ...base, ...patch }));
}

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
    models: [
      cliModel('big-pickle', 'opencode', 'free'),
      cliModel('deepseek-v4.1-flash', 'opencode-go', 'included_subscription'),
    ],
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

interface Setup {
  h: CoreHarness;
  calls: CliBrokerRequest[];
  scanCalls: CliConnectionKind[];
  service: ReturnType<typeof getCliConnectionService>;
}

async function setup(
  options: { connection?: CliConnection; fail?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<Setup> {
  const connection = options.connection ?? openCodeConnection();
  const calls: CliBrokerRequest[] = [];
  const scanCalls: CliConnectionKind[] = [];
  const runner: CliTurnRunner = (request) => {
    if (options.fail)
      return Promise.reject(new CliTransportError('authentication', 'credential rejected'));
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready('ALIAS-OK', request));
  };
  harness = await startHarness({
    cliScan: (kind) => {
      scanCalls.push(kind);
      return Promise.resolve(
        kind === 'opencode-cli'
          ? connection
          : { ...openCodeConnection(), id: kind, kind, providerId: kind, models: [] },
      );
    },
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn: runner,
    ...(options.env ? { env: options.env } : {}),
  });
  const service = getCliConnectionService(harness.services, () => undefined);
  return { h: harness, calls, scanCalls, service };
}

/** Seed the persisted legacy free Zen API ref so the agent can resolve an old pin. */
function seedLegacyOpencodeModel(services: FerryServices): ModelRef {
  const legacy = services.catalog.models.find((model) => model.ref === LEGACY);
  if (!legacy) throw new Error('Missing opencode/big-pickle catalog fixture');
  services.models.replace(OPENCODE, [legacy]);
  return legacy.ref;
}

function allowlistProfile(refs: ModelRef[], allowSubscriptionCli = false): Profile {
  return {
    ...builtinProfile,
    allowedProviders: 'all',
    allowedModelRefs: refs.length ? refs : undefined,
    allowSubscriptionCli,
  } as Profile;
}

it('resolves a persisted legacy opencode/<id> ref to the discovered canonical CLI ref', () => {
  expect(legacyZenAliasId(LEGACY)).toBe('big-pickle');
  expect(legacyZenAliasId(CANONICAL)).toBeNull();
  expect(legacyZenAliasId('openrouter/x')).toBeNull();
  expect(canonicalZenRef('big-pickle')).toBe(CANONICAL);
});

it('routes an old persisted opencode/<id> pin through the canonical CLI route on Auto-Free', async () => {
  const { h, calls, service } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  service.update('opencode-cli', {
    surfaces: { native: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  seedLegacyOpencodeModel(h.services);
  await h.rpc.providers.setEnabled(OPENCODE, true);

  const verified = await h.rpc.providers.verifyZenCli(LEGACY);
  expect(verified.ok, verified.message).toBe(true);

  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(session.id, LEGACY);
  expect((await h.rpc.sessions.get(session.id)).session.pinnedModelRef).toBe(LEGACY);

  await h.rpc.sessions.send(session.id, { text: 'answer from the alias' });
  await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');

  const detail = await h.rpc.sessions.get(session.id);
  expect(detail.session.pinnedModelRef).toBe(LEGACY);
  const assistant = detail.messages.findLast(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some((part) => part.type === 'text' && part.text.includes('ALIAS-OK')),
  );
  expect(assistant).toBeTruthy();
  const textPart = assistant?.parts.find((part) => part.type === 'text');
  expect(textPart && 'producedBy' in textPart ? textPart.producedBy : undefined).toBe(CANONICAL);

  const usage = await h.rpc.sessions.modelUsage(session.id);
  expect(usage.models.map((model) => model.modelRef)).toContain(CANONICAL);
  const request = h.services.db.client
    .prepare('SELECT model, headers_json FROM requests WHERE session_id = ? ORDER BY ts DESC')
    .get(session.id) as { model: string; headers_json: string | null } | undefined;
  expect(request?.model).toBe(CANONICAL);
  const headers = JSON.parse(request?.headers_json ?? '{}') as Record<string, string>;
  expect(headers['ferry.requestedModelRef']).toBe(LEGACY);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.model.ref).toBe(CANONICAL);
  expect(calls[0]?.model.upstreamId).toBe('opencode/big-pickle');
});

it('keeps a standard Zen API pin on the API when the shared CLI is enabled for general/Go use', async () => {
  const { h, calls, service } = await setup();
  // The shared OpenCode CLI is enabled for general/Go use, but the Zen transport is explicitly API.
  putGlobal(h.services, { opencodeZenTransport: 'api', zenCliMigratedToShared: true });
  service.update('opencode-cli', {
    surfaces: { native: true, gateway: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  seedLegacyOpencodeModel(h.services);
  await h.rpc.providers.setEnabled(OPENCODE, true);
  // A legitimate saved Zen API key + a loopback API endpoint for the offline fixture.
  const apiModel = h.services.models.list(OPENCODE)[0];
  if (!apiModel) throw new Error('Missing API model');
  h.services.models.replace(OPENCODE, [{ ...apiModel, apiAccessVerified: true }]);
  (h.services.env as Record<string, string>).FERRY_PROVIDER_BASE_URL_OPENCODE =
    `${h.server.baseUrl}/v1`;
  await h.services.secrets.set(OPENCODE, 'zen-api-key');
  h.services.providerKeys.put({
    id: OPENCODE,
    providerId: OPENCODE,
    keyringRef: OPENCODE,
    createdAt: new Date().toISOString(),
  });

  // The canonical Zen CLI model is discovered, yet the old API ref never aliases to it.
  expect(getCliBroker(h.services, () => undefined).model(LEGACY)).toBeUndefined();

  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(session.id, LEGACY);
  await h.rpc.sessions.send(session.id, { text: 'serve through the standard API' });
  await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
  // The real API server was used; no CLI generation ran.
  expect(calls).toHaveLength(0);
  expect(
    h.server.requests.filter((request) => request.url.includes('/chat/completions')),
  ).toHaveLength(1);
  expect((await h.rpc.sessions.get(session.id)).session.pinnedModelRef).toBe(LEGACY);

  // Switching the Zen transport to CLI maps the *same* old pin to the canonical broker route.
  putGlobal(h.services, { opencodeZenTransport: 'cli' });
  const verified = await h.rpc.providers.verifyZenCli(LEGACY);
  expect(verified.ok, verified.message).toBe(true);
  const serverCallsAfterApi = h.server.requests.length;
  await h.rpc.sessions.send(session.id, { text: 'now through the CLI alias' });
  await waitFor(async () =>
    (await h.rpc.sessions.get(session.id)).messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.parts.some((part) => part.type === 'text' && part.text.includes('ALIAS-OK')),
    ),
  );
  const detail = await h.rpc.sessions.get(session.id);
  expect(detail.session.pinnedModelRef).toBe(LEGACY);
  const produced = detail.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text' && part.text.includes('ALIAS-OK'))
    .map((part) => ('producedBy' in part ? part.producedBy : undefined));
  expect(produced).toContain(CANONICAL);
  expect(h.server.requests.length).toBe(serverCallsAfterApi);
  expect(calls.at(-1)?.model.ref).toBe(CANONICAL);
});

it('keeps native and gateway opt-ins independent and never bypasses an explicit opt-out', () => {
  const settings = (
    native: boolean,
    gateway: boolean,
    migrated: boolean | undefined,
    withRecord = true,
  ) =>
    ({
      settings: {
        get: (key: string) =>
          key === 'global'
            ? {
                opencodeZenTransport: 'cli',
                zenCliMigratedToShared: migrated,
                cliConnections: withRecord
                  ? {
                      'opencode-cli': {
                        native,
                        gateway,
                        credentialMode: 'installed',
                        credentialProvider: null,
                      },
                    }
                  : {},
              }
            : undefined,
        put: () => undefined,
      },
    }) as unknown as Pick<FerryServices, 'settings'>;
  expect(zenCliMode(settings(false, true, true))).toBe(false);
  expect(zenCliMode(settings(false, true, true), 'gateway')).toBe(true);
  expect(zenCliMode(settings(true, false, true))).toBe(true);
  expect(zenCliMode(settings(true, false, true), 'gateway')).toBe(false);
  // Before migration with no shared record the legacy flag enables both surfaces.
  expect(zenCliMode(settings(false, false, false, false))).toBe(true);
  expect(zenCliMode(settings(false, false, false, false), 'gateway')).toBe(true);
  // A migration flag that is missing must not let the legacy flag bypass an explicit shared false.
  expect(zenCliMode(settings(false, false, undefined))).toBe(false);
  expect(zenCliMode(settings(false, false, false))).toBe(false);
  // A generic (non-Zen) CLI selection never enables Zen CLI mode: transport stays API.
  const apiTransport = {
    settings: {
      get: (key: string) =>
        key === 'global'
          ? {
              opencodeZenTransport: 'api',
              zenCliMigratedToShared: true,
              cliConnections: { 'opencode-cli': { native: true, gateway: true } },
            }
          : undefined,
      put: () => undefined,
    },
  } as unknown as Pick<FerryServices, 'settings'>;
  expect(zenCliMode(apiTransport)).toBe(false);
  expect(zenCliMode(apiTransport, 'gateway')).toBe(false);
});

it('serves the status from the cached connection without an extra discovery scan', async () => {
  const { h, service, scanCalls } = await setup();
  await service.refresh('opencode-cli');
  const scansAfterRefresh = scanCalls.filter((kind) => kind === 'opencode-cli').length;
  const status = await zenCliStatus(h.services);
  expect(status.available).toBe(true);
  expect(status.version).toBe('1.18.35');
  expect(status.freeModels.map((model) => model.ref)).toContain(CANONICAL);
  expect(scanCalls.filter((kind) => kind === 'opencode-cli').length).toBe(scansAfterRefresh);
});

it.each(['opencode-cli/opencode/missing-model', GO_CANONICAL])(
  'rejects an explicit non-free or undiscovered Zen verification target %s',
  async (ref) => {
    const { h, service } = await setup();
    await service.refresh('opencode-cli');
    const result = await h.rpc.providers.verifyZenCli(ref);
    expect(result).toMatchObject({ ok: false, modelRef: ref });
    expect((await h.rpc.providers.zenCliStatus()).verifiedModels).toEqual([]);
    expect(getCliBroker(h.services, () => undefined).connections()[0]?.verify.state).not.toBe(
      'verified',
    );
  },
);

it('offers only free Zen models discovered by the installed CLI', async () => {
  const discovered = cliModel('new-free-model', 'opencode', 'free');
  const { h, service } = await setup({
    connection: openCodeConnection({ models: [discovered] }),
  });
  await service.refresh('opencode-cli');
  expect((await h.rpc.providers.zenCliStatus()).freeModels).toEqual([
    { ref: discovered.ref, name: discovered.name },
  ]);
});

it('reports a Go-only credential as Go with no Zen entitlement', async () => {
  const dataHome = await openCodeAuthHome({ 'opencode-go': { type: 'api', key: 'go-only-key' } });
  const { h, service } = await setup({
    env: { XDG_DATA_HOME: dataHome },
    connection: openCodeConnection({
      account: {
        state: 'signed_in',
        key: `opencode-cli:${'b'.repeat(24)}`,
        label: 'OpenCode Go',
        plan: null,
      },
    }),
  });
  service.update('opencode-cli', {
    surfaces: { native: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  const status = await zenCliStatus(h.services);
  expect(status.credentialSource).toBe('opencode_go');
  expect(status.verifiedModels).toEqual([]);
});

it('binds an explicit installed-Go offer proof to the Go credential source', async () => {
  const dataHome = await openCodeAuthHome({ 'opencode-go': { type: 'api', key: 'go-offer-key' } });
  const { h, service } = await setup({ env: { XDG_DATA_HOME: dataHome } });
  service.update('opencode-cli', {
    surfaces: { native: true, gateway: true },
    credentialMode: 'installed',
    credentialProvider: 'opencode-go',
  });
  await service.refresh('opencode-cli');
  const broker = getCliBroker(h.services, () => undefined);
  const result = await broker.verify('opencode-cli', CANONICAL);
  expect(result.ok, result.message).toBe(true);
  const receipt = broker.connections().find((entry) => entry.kind === 'opencode-cli')?.verify
    .modelReceipts?.[CANONICAL];
  expect(receipt?.credentialKey ?? null).not.toBeNull();
  const status = await zenCliStatus(h.services);
  expect(status.credentialSource).toBe('opencode_go');
  expect(status.verifiedModels).toContain(CANONICAL);
});

it('verifies anonymous free Zen with a null-account receipt and reports Ferry mode distinctly', async () => {
  const { h, service } = await setup({
    connection: openCodeConnection({
      account: { state: 'not_checked', key: null, label: null, plan: null },
    }),
  });
  service.update('opencode-cli', {
    surfaces: { native: true, gateway: true },
    credentialMode: 'anonymous',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  const broker = getCliBroker(h.services, () => undefined);
  expect((await broker.verify('opencode-cli', CANONICAL)).ok).toBe(true);
  const anonymousStatus = await zenCliStatus(h.services);
  expect(anonymousStatus.credentialSource).toBe('anonymous');
  expect(anonymousStatus.verifiedModels).toContain(CANONICAL);
  const receipt = broker.connections().find((entry) => entry.kind === 'opencode-cli')?.verify
    .modelReceipts?.[CANONICAL];
  expect(receipt?.credentialKey ?? null).toBeNull();

  service.update('opencode-cli', { credentialMode: 'ferry', credentialProvider: null });
  await service.refresh('opencode-cli');
  const ferryStatus = await zenCliStatus(h.services);
  expect(ferryStatus.credentialSource).toBe('ferry');
  expect(JSON.stringify(ferryStatus)).not.toMatch(/[a-f0-9]{32,}/);
});

it('exposes a redacted, useful error when the shared verification fails', async () => {
  const { h, service } = await setup({ fail: true });
  service.update('opencode-cli', {
    surfaces: { native: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  const result = await verifyZenCli(h.services, CANONICAL);
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/credential rejected/);
  expect(result.modelRef).toBe(CANONICAL);
});

it('dedupes the canonical and legacy Zen route and keeps a saved profile allowlist alias usable', async () => {
  const { h, service } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'cli', zenCliMigratedToShared: true });
  service.update('opencode-cli', {
    surfaces: { native: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  seedLegacyOpencodeModel(h.services);
  await h.rpc.providers.setEnabled(OPENCODE, true);
  const broker = getCliBroker(h.services, () => undefined);
  expect((await broker.verify('opencode-cli', CANONICAL)).ok).toBe(true);

  const listed = await h.rpc.models.list();
  const zen = listed.filter((model) => model.ref === LEGACY || model.ref === CANONICAL);
  expect(zen).toHaveLength(1);
  expect(zen[0]?.ref).toBe(CANONICAL);

  const eligible = broker.eligibleModels({
    surface: 'native',
    profile: allowlistProfile([LEGACY]),
  });
  expect(eligible.map((model) => model.ref)).toEqual([CANONICAL]);
});

it('preserves a standard API row while API transport is selected and dedupes only the active CLI alias', async () => {
  const { h, service } = await setup();
  putGlobal(h.services, { opencodeZenTransport: 'api', zenCliMigratedToShared: true });
  service.update('opencode-cli', {
    surfaces: { native: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  seedLegacyOpencodeModel(h.services);
  await h.rpc.providers.setEnabled(OPENCODE, true);

  // Canonical CLI model is discovered, but the API row is a distinct legitimate choice: keep both.
  const apiRows = (await h.rpc.models.list()).filter(
    (model) => model.ref === LEGACY || model.ref === CANONICAL,
  );
  expect(apiRows.map((model) => model.ref)).toEqual(expect.arrayContaining([LEGACY, CANONICAL]));
  expect(apiRows).toHaveLength(2);

  // Once the Zen CLI transport is selected, the legacy row is deduped onto the canonical route.
  putGlobal(h.services, { opencodeZenTransport: 'cli' });
  const cliRows = (await h.rpc.models.list()).filter(
    (model) => model.ref === LEGACY || model.ref === CANONICAL,
  );
  expect(cliRows.map((model) => model.ref)).toEqual([CANONICAL]);
});

it('keeps anonymous free Zen eligible while an exhausted Go Included window hides only Included', async () => {
  const dataHome = await openCodeAuthHome({ 'opencode-go': { type: 'api', key: 'go-key' } });
  const { h, service } = await setup({ env: { XDG_DATA_HOME: dataHome } });
  service.update('opencode-cli', {
    surfaces: { native: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  const broker = getCliBroker(h.services, () => undefined);
  expect((await broker.verify('opencode-cli', CANONICAL)).ok).toBe(true);
  expect((await broker.verify('opencode-cli', GO_CANONICAL)).ok).toBe(true);

  // The Go Included account window is now known-exhausted; the free Zen bucket is unrelated.
  service.applyUsage('opencode-cli', {
    connectionId: 'opencode-cli',
    accountKey: null,
    state: 'available',
    source: 'cli',
    observedAt: null,
    staleAt: null,
    windows: [
      {
        id: 'opencode-go:primary',
        label: 'OpenCode Go',
        metric: 'percent',
        windowKind: 'five_hour',
        used: 100,
        limit: 100,
        remaining: 0,
        utilization: 1,
        resetAt: '2099-01-01T00:00:00.000Z',
      },
    ],
    note: null,
  });
  const eligible = broker.eligibleModels({
    surface: 'native',
    profile: allowlistProfile([], true),
  });
  expect(eligible.map((model) => model.ref)).toContain(CANONICAL);
  expect(eligible.map((model) => model.ref)).not.toContain(GO_CANONICAL);
});

it('leaves the standard Zen API path unchanged when API is selected', async () => {
  const h = await startHarness();
  harness = h;
  seedLegacyOpencodeModel(h.services);
  await h.rpc.providers.setEnabled(OPENCODE, true);
  const broker = getCliBroker(h.services, () => undefined);
  broker.connections(); // warm the cached snapshot only
  expect(broker.model(LEGACY)).toBeUndefined();
  const listed = await h.rpc.models.list(OPENCODE);
  const row = listed.find((model) => model.ref === LEGACY);
  expect(row?.transport).not.toBe('opencode_cli');
  expect(row?.free).toBe(true);
  expect(listed.some((model) => model.ref === GO_CANONICAL)).toBe(false);
});
