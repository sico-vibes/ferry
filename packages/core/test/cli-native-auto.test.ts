import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BUILTIN_PROFILES } from '@ferry/router';
import { MemorySecretStore } from '@ferry/secrets';
import { createRpcFerryClient, type RpcFerryClient } from '@ferry/client';
import { FakeOpenAIServer, type FakeResponse } from '@ferry/testkit';
import { CliTransportError, type CliTurnResult } from '@ferry/delegate';
import {
  ModelInfoSchema,
  ProfileIdSchema,
  ProviderIdSchema,
  type CliConnection,
  type CliConnectionKind,
  type CliModelCapabilities,
  type CliUsageSnapshot,
  type MessagePart,
  type ModelRef,
  type SessionId,
  type WorkspaceId,
} from '@ferry/shared';
import {
  createCoreHost,
  createMemoryTransportPair,
  type CoreHost,
  type FerryServices,
} from '../src/index.js';
import type { CliBrokerRequest, CliTurnRunner } from '../src/cli-broker.js';
import { textTurn } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });

// Role planning would insert a planner model ahead of the routed CLI model; these fixtures predate it.
for (const name of ['Auto-Free', 'Best Available']) {
  const fixture = BUILTIN_PROFILES.find((profile) => profile.name === name);
  if (fixture) fixture.roles.enabled = false;
}
const autoFreeProfile = BUILTIN_PROFILES.find(
  (profile) => profile.id === 'profile_builtin_auto_free',
);
if (!autoFreeProfile) throw new Error('missing Auto-Free profile');

let harness: CliAutoHarness | undefined;
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

interface CliAutoOptions {
  connections: Record<CliConnectionKind, CliConnection>;
  /** Scripted generation (verification is always answered Ready). */
  respond?: (request: CliBrokerRequest) => CliTurnResult | Promise<CliTurnResult>;
  onCall?: (request: CliBrokerRequest) => void;
  env?: NodeJS.ProcessEnv;
  /** Enables one real loopback API provider with a free fixture model. */
  api?: { provider: string; turns: FakeResponse[] };
}

interface CliAutoHarness {
  root: string;
  host: CoreHost;
  rpc: RpcFerryClient;
  services: FerryServices;
  workspaceId: WorkspaceId;
  server?: FakeOpenAIServer;
  close(): Promise<void>;
}

async function startCliAuto(options: CliAutoOptions): Promise<CliAutoHarness> {
  const root = await mkdtemp(join(tmpdir(), 'ferry-cli-auto-'));
  const dataDir = join(root, 'data');
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  let server: FakeOpenAIServer | undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    FERRY_TEST_KEYRING_NAMESPACE: `ferry-cli-auto-${String(process.pid)}`,
    FERRY_KEYRING_SERVICE: `Ferry-Cli-Auto-${String(process.pid)}`,
    ...options.env,
  };
  if (options.api) {
    server = new FakeOpenAIServer({ responses: options.api.turns });
    await server.start();
    env[`FERRY_PROVIDER_BASE_URL_${options.api.provider.toUpperCase()}`] = `${server.baseUrl}/v1`;
  }
  const runner: CliTurnRunner = async (request) => {
    if (isVerify(request)) return ready('Ready', request);
    options.onCall?.(request);
    return options.respond ? await options.respond(request) : ready('ok', request);
  };
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({
    dataDir,
    transport: coreTransport,
    env,
    cliScan: (kind) => Promise.resolve(options.connections[kind]),
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn: runner,
  });
  const services = host.options.services;
  if (!services) {
    await host.stop();
    await server?.stop();
    throw new Error('Core services were not created');
  }
  const secrets = new MemorySecretStore();
  (services as { secrets: FerryServices['secrets'] }).secrets = secrets;
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 30_000 });
  await rpc.hello;
  const apiProviderId = options.api ? ProviderIdSchema.parse(options.api.provider) : undefined;
  // Seed the loopback key first so its provider record resolves a usable key, then disable every
  // other API provider (keyless providers included) so only the intended route can be selected.
  if (apiProviderId) {
    await secrets.set(apiProviderId, 'fixture-key');
    services.providerKeys.put({
      id: apiProviderId,
      providerId: apiProviderId,
      keyringRef: apiProviderId,
      createdAt: new Date().toISOString(),
    });
  }
  for (const { provider } of services.catalog.providers) {
    const id = ProviderIdSchema.parse(provider);
    if (id === apiProviderId) continue;
    await rpc.providers.setEnabled(id, false);
  }
  if (apiProviderId) {
    await rpc.providers.setEnabled(apiProviderId, true);
    const catalogFixture = services.catalog.models.find(
      (model) => model.providerId === apiProviderId && model.toolCalling,
    );
    // The loopback provider may have no catalog capability metadata; a synthesized egress model keeps
    // the free-API assertion on the real transport path without depending on catalog data.
    const fixture =
      catalogFixture ??
      ModelInfoSchema.parse({
        ref: `${apiProviderId}/qa-free-fixture`,
        providerId: apiProviderId,
        name: 'QA free fixture',
        tier: 'T2',
        contextWindow: 128_000,
        maxOutput: 4_096,
        toolCalling: true,
        reasoning: false,
        free: true,
        priceInPerM: 0,
        priceOutPerM: 0,
      });
    services.models.put(
      apiProviderId,
      ModelInfoSchema.parse({ ...fixture, free: true, priceInPerM: 0, priceOutPerM: 0 }),
    );
  }
  const workspace = await rpc.workspaces.open(workspacePath);
  await rpc.workspaces.trust(workspace.id);
  const created: CliAutoHarness = {
    root,
    host,
    rpc,
    services,
    workspaceId: workspace.id,
    ...(server ? { server } : {}),
    async close() {
      rpc.close();
      try {
        await server?.stop();
      } finally {
        try {
          await host.stop();
        } finally {
          await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
        }
      }
    },
  };
  harness = created;
  return created;
}

async function optInAndVerify(
  h: CliAutoHarness,
  kind: CliConnectionKind,
  refs: readonly ModelRef[],
  surfaces: { native?: boolean; gateway?: boolean } = { native: true },
): Promise<void> {
  await h.rpc.cliConnections.refresh(kind);
  await h.rpc.cliConnections.update(kind, { surfaces });
  for (const ref of refs) {
    const result = await h.rpc.cliConnections.verify(kind, ref);
    expect(result.ok, result.message).toBe(true);
  }
}

async function waitIdle(h: CliAutoHarness, sessionId: SessionId): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const detail = await h.rpc.sessions.get(sessionId);
    if (detail.session.status === 'idle') return;
    if (Date.now() > deadline) throw new Error(`session did not idle: ${detail.session.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/* ------------------------------ AUTO to free CLI ------------------------- */

it('AUTO send routes to a free installed-CLI model with no API providers enabled', async () => {
  const calls: CliBrokerRequest[] = [];
  const h = await startCliAuto({
    connections: {
      'codex-cli': connection('codex-cli', [modelFor('codex-cli', 'free-a', { billing: 'free' })]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    onCall: (request) => calls.push(request),
    respond: (request) => ready('free cli answer', request),
  });
  const ref = 'codex-cli/free-a' as ModelRef;
  await optInAndVerify(h, 'codex-cli', [ref]);
  const session = await h.rpc.sessions.create({
    workspaceId: h.workspaceId,
    profileId: autoFreeProfile.id,
  });
  await h.rpc.sessions.send(session.id, { text: 'Say hello' });
  await waitIdle(h, session.id);

  // The actual free CLI transport ran; no API provider was available.
  expect(calls.map((call) => call.model.ref)).toContain(ref);
  const detail = await h.rpc.sessions.get(session.id);
  const texts = detail.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text);
  expect(texts).toContain('free cli answer');
});

/* ------------------------ free API beats Included CLI --------------------- */

it('a free API model outranks an opted-in Included CLI model on Auto-Free', async () => {
  const cliCalls: CliBrokerRequest[] = [];
  const h = await startCliAuto({
    api: { provider: 'sambanova', turns: [textTurn('api answer')] },
    connections: {
      'codex-cli': connection('codex-cli', [
        modelFor('codex-cli', 'inc-a', { billing: 'included_subscription' }),
      ]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    onCall: (request) => cliCalls.push(request),
    respond: (request) => ready('cli answer', request),
  });
  const incRef = 'codex-cli/inc-a' as ModelRef;
  await optInAndVerify(h, 'codex-cli', [incRef]);
  const profile = {
    ...autoFreeProfile,
    id: ProfileIdSchema.parse('profile_test_cli_included_optin'),
    name: 'Auto-Free + CLI included',
    builtin: false,
    allowSubscriptionCli: true,
  };
  await h.rpc.profiles.save(profile);
  const session = await h.rpc.sessions.create({
    workspaceId: h.workspaceId,
    profileId: profile.id,
  });
  await h.rpc.sessions.send(session.id, { text: 'Say hello' });
  await waitIdle(h, session.id);

  // The free API provider served the turn; the Included CLI transport never ran.
  expect(h.server?.requests.length ?? 0).toBeGreaterThan(0);
  expect(cliCalls).toHaveLength(0);
  const detail = await h.rpc.sessions.get(session.id);
  const texts = detail.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text);
  expect(texts).toContain('api answer');
});

/* -------------------------- free CLI beats Included ----------------------- */

it('a free CLI model outranks an opted-in Included CLI model', async () => {
  const calls: CliBrokerRequest[] = [];
  const h = await startCliAuto({
    connections: {
      'codex-cli': connection('codex-cli', [
        modelFor('codex-cli', 'free-a', { billing: 'free' }),
        modelFor('codex-cli', 'inc-a', { billing: 'included_subscription' }),
      ]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    onCall: (request) => calls.push(request),
    respond: (request) => ready(`served ${request.model.ref}`, request),
  });
  await optInAndVerify(h, 'codex-cli', [
    'codex-cli/free-a' as ModelRef,
    'codex-cli/inc-a' as ModelRef,
  ]);
  const profile = {
    ...autoFreeProfile,
    id: ProfileIdSchema.parse('profile_test_cli_free_vs_included'),
    name: 'Auto-Free free-vs-included',
    builtin: false,
    allowSubscriptionCli: true,
  };
  await h.rpc.profiles.save(profile);
  const session = await h.rpc.sessions.create({
    workspaceId: h.workspaceId,
    profileId: profile.id,
  });
  await h.rpc.sessions.send(session.id, { text: 'Say hello' });
  await waitIdle(h, session.id);

  expect(calls.map((call) => call.model.ref)).toEqual(['codex-cli/free-a']);
});

/* ----------------------- manual Included, no approval -------------------- */

it('an explicit manual Included selection dispatches without a paid approval', async () => {
  const calls: CliBrokerRequest[] = [];
  const h = await startCliAuto({
    connections: {
      'codex-cli': connection('codex-cli', [
        modelFor('codex-cli', 'inc-a', { billing: 'included_subscription' }),
      ]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    onCall: (request) => calls.push(request),
    respond: (request) => ready('manual included answer', request),
  });
  const incRef = 'codex-cli/inc-a' as ModelRef;
  await optInAndVerify(h, 'codex-cli', [incRef]);
  // Default Auto-Free profile, no allowSubscriptionCli opt-in, no paid allowance.
  const session = await h.rpc.sessions.create({
    workspaceId: h.workspaceId,
    profileId: autoFreeProfile.id,
  });
  await h.rpc.models.select(session.id, incRef);
  await h.rpc.sessions.send(session.id, { text: 'Say hello' });
  await waitIdle(h, session.id);

  expect(calls.map((call) => call.model.ref)).toEqual([incRef]);
  const detail = await h.rpc.sessions.get(session.id);
  const approvals = detail.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'approval_request');
  expect(approvals).toHaveLength(0);
  const texts = detail.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text);
  expect(texts).toContain('manual included answer');
});

/* --------------------- exhaustion fallback across accounts --------------- */

it('blocks the same exhausted bucket, then serves from another verified connection', async () => {
  const calls: CliBrokerRequest[] = [];
  const seenByC: string[] = [];
  let claudeStep = 0;
  const h = await startCliAuto({
    connections: {
      // The failing connection sorts first in the deterministic Auto tie-break; the exhausted bucket
      // covers both of its models, so the other verified connection must take over.
      'claude-code-cli': connection('claude-code-cli', [
        modelFor('claude-code-cli', 'model-a', { billing: 'free' }),
        modelFor('claude-code-cli', 'model-b', { billing: 'free' }),
      ]),
      'codex-cli': connection('codex-cli', [modelFor('codex-cli', 'model-c', { billing: 'free' })]),
      'opencode-cli': connection('opencode-cli', []),
    },
    onCall: (request) => calls.push(request),
    respond: (request) => {
      if (request.model.connectionId === 'claude-code-cli') {
        claudeStep += 1;
        if (claudeStep === 1)
          return {
            text: '',
            toolCalls: [
              {
                id: 'call_plan',
                name: 'update_plan',
                arguments: { items: [{ id: 'p1', text: 'gather facts', status: 'pending' }] },
              },
            ],
            usage: {
              inputTokens: null,
              outputTokens: null,
              cachedTokens: null,
              reasoningTokens: null,
            },
            responseModel: request.model.upstreamId,
          };
        throw new CliTransportError('exhausted_capacity', 'claude window exhausted');
      }
      // Only model-c reaches the runner on the other connection.
      seenByC.push(
        ...request.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.content ?? ''),
      );
      return ready('continued from tool result', request);
    },
  });
  await optInAndVerify(h, 'claude-code-cli', [
    'claude-code-cli/model-a' as ModelRef,
    'claude-code-cli/model-b' as ModelRef,
  ]);
  await optInAndVerify(h, 'codex-cli', ['codex-cli/model-c' as ModelRef]);
  const session = await h.rpc.sessions.create({
    workspaceId: h.workspaceId,
    profileId: autoFreeProfile.id,
  });
  // Pin the failing model so the first generation is deterministic; the pin handover then decides
  // the fallback, exercising the shared bucket guard.
  await h.rpc.models.select(session.id, 'claude-code-cli/model-a' as ModelRef);
  await h.rpc.sessions.send(session.id, { text: 'Please plan then finish' });
  await waitIdle(h, session.id);

  const runnerRefs = calls.map((call) => call.model.ref);
  // model-b shares the exhausted claude account bucket and never reached the runner.
  expect(runnerRefs).not.toContain('claude-code-cli/model-b');
  // The other verified connection served the continuation.
  expect(runnerRefs).toContain('codex-cli/model-c');
  // The caller's tool result from the exhausted model was carried into the fallback conversation.
  expect(seenByC.some((content) => content.length > 0)).toBe(true);
  const detail = await h.rpc.sessions.get(session.id);
  const texts = detail.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text);
  expect(texts).toContain('continued from tool result');
});

/* --------------------- surface independence (broker pool) ---------------- */

it('Included CLI requires native opt-in; a gateway-only opt-in is independent', async () => {
  const h = await startCliAuto({
    connections: {
      'codex-cli': connection('codex-cli', [
        modelFor('codex-cli', 'inc-a', { billing: 'included_subscription' }),
        modelFor('codex-cli', 'free-a', { billing: 'free' }),
      ]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
  });
  const incRef = 'codex-cli/inc-a' as ModelRef;
  const freeRef = 'codex-cli/free-a' as ModelRef;
  // Gateway-only opt-in: native Auto sees no CLI capacity at all.
  await optInAndVerify(h, 'codex-cli', [incRef, freeRef], { gateway: true });
  const profile = { ...autoFreeProfile, allowSubscriptionCli: true };
  const nativePool = h.services;
  const { getCliBroker } = await import('../src/cli-broker.js');
  const broker = getCliBroker(nativePool, () => undefined);
  expect(broker.eligibleModels({ surface: 'native', profile })).toEqual([]);
  // Native opt-in makes the free route eligible, and the Included route only with the opt-in flag.
  await h.rpc.cliConnections.update('codex-cli', { surfaces: { native: true } });
  expect(
    broker
      .eligibleModels({ surface: 'native', profile: { ...profile, allowSubscriptionCli: false } })
      .map((model) => model.ref),
  ).toEqual([freeRef]);
  expect(broker.eligibleModels({ surface: 'native', profile }).map((model) => model.ref)).toEqual([
    freeRef,
    incRef,
  ]);
});

/* --------------- unsupported options / Fast / LongContext gating --------- */

it('eligibleModels excludes unsupported options, un-bound Fast, and unknown long-context capacity', async () => {
  const h = await startCliAuto({
    connections: {
      'codex-cli': connection('codex-cli', [
        modelFor('codex-cli', 'free-a', { billing: 'free', contextWindow: null, maxOutput: null }),
      ]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
  });
  const ref = 'codex-cli/free-a' as ModelRef;
  await optInAndVerify(h, 'codex-cli', [ref]);
  const { getCliBroker } = await import('../src/cli-broker.js');
  const { createSessionDependencies } = await import('../src/session-deps.js');
  const broker = getCliBroker(h.services, () => undefined);
  const base = {
    ...autoFreeProfile,
    allowedProviders: 'all' as const,
    allowSubscriptionCli: false,
  };
  expect(broker.eligibleModels({ surface: 'native', profile: base }).map((m) => m.ref)).toEqual([
    ref,
  ]);
  // A profile per-model default that selects Fast (never auto-authorized) excludes the route.
  expect(
    broker.eligibleModels({
      surface: 'native',
      profile: { ...base, cliDefaults: { [ref]: { effort: null, speed: 'fast' } } },
    }),
  ).toEqual([]);
  // An unsupported configured effort excludes the route as well.
  expect(
    broker.eligibleModels({
      surface: 'native',
      profile: { ...base, cliDefaults: { [ref]: { effort: 'ultra', speed: 'standard' } } },
    }),
  ).toEqual([]);

  // The unknown-capacity policy placeholder is never advertised as a real context window, and a
  // Long Context step never routes to it while a normal step still can.
  const conn = (await h.rpc.cliConnections.refresh('codex-cli')).find(
    (entry) => entry.kind === 'codex-cli',
  );
  expect(conn?.models.find((model) => model.ref === ref)?.contextWindow ?? null).toBeNull();
  const deps = createSessionDependencies(h.services, () => undefined, undefined, { profile: base });
  expect(
    deps.gateway.resolveCandidates(base, 'long_context', 200_000, true).map((model) => model.ref),
  ).not.toContain(ref);
  expect(deps.gateway.resolveCandidates(base, 'plan', 1, true).map((model) => model.ref)).toContain(
    ref,
  );
});
