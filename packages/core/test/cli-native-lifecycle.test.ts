import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRpcFerryClient, type RpcFerryClient } from '@ferry/client';
import type { CliTurnResult } from '@ferry/delegate';
import { DIRECT_PROFILE_ID } from '@ferry/shared';
import { sampleSettings } from '@ferry/shared/testing';
import type {
  CliConnection,
  CliConnectionKind,
  CliModelCapabilities,
  CliUsageSnapshot,
  Message,
  MessagePart,
  ModelRef,
  ProviderId,
  SessionDetail,
  SessionId,
} from '@ferry/shared';
import { unsupportedCliImageMessage } from '../src/session-deps.js';
import type { CliConnectionServiceOptions } from '../src/cli-connections.js';
import type { CliTurnRunner, CliBrokerRequest } from '../src/cli-broker.js';
import { createCoreHost, createMemoryTransportPair, type CoreHost } from '../src/index.js';
import type { FerryServices } from '../src/index.js';

vi.setConfig({ testTimeout: 30_000 });

const KINDS: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];
const MODEL_ID: Record<CliConnectionKind, string> = {
  'codex-cli': 'gpt-6.1-sol',
  'claude-code-cli': 'claude-haiku-5-5',
  'opencode-cli': 'opencode-go/deepseek-v4.1-flash',
};
const MARKER = 'FERRY_CORE_SAFE_MARKER';
const TOOL_CALL_ID = 'call_marker_1';

/** `models.list` takes a branded provider id; CLI kinds are provider ids at runtime. */
const cliProviderId = (kind: CliConnectionKind): ProviderId => kind as unknown as ProviderId;

let harness: CliLifecycleHarness | undefined;
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
    upstreamProvider: kind === 'opencode-cli' ? 'opencode-go' : null,
    name: `Model ${id}`,
    efforts: ['low', 'high'],
    defaultEffort: 'low',
    speeds: ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    // Unknown native context/output: the transport policy bound must substitute, never a fake 8192.
    billing: 'included_subscription',
    hidden: false,
    ...overrides,
  };
}

function fixture(
  kind: CliConnectionKind,
  models?: CliModelCapabilities[],
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
    models: models ?? [modelFor(kind, MODEL_ID[kind])],
    usage: emptyUsage(kind),
    lastChecked: null,
    discoveryMessage: null,
    ...overrides,
  };
}

function turn(
  text: string,
  toolCalls: CliTurnResult['toolCalls'],
  usage: CliTurnResult['usage'],
  responseModel: string,
): CliTurnResult {
  return { text, toolCalls, usage, responseModel };
}

function nullUsage() {
  return { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null };
}

/**
 * Offline fake CLI transport. The verification prompt answers "Ready"; a text request answers READY
 * (with a deliberately partial usage record: input + cached reported, output + reasoning unreported);
 * a request naming the marker returns one real `read_file` tool call; the continuation echoes back
 * the real tool result content.
 */
function makeRunner(calls: CliBrokerRequest[]): CliTurnRunner {
  const decide = (request: CliBrokerRequest): CliTurnResult => {
    if (
      request.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('Reply with exactly Ready'),
      )
    )
      return turn('Ready', [], nullUsage(), request.model.upstreamId);
    calls.push(request);
    const explicitTool = request.messages.at(-1);
    if (explicitTool?.role === 'tool')
      return turn(
        explicitTool.content ?? '',
        [],
        { inputTokens: 4, outputTokens: 2, cachedTokens: 0, reasoningTokens: null },
        request.model.upstreamId,
      );
    const user = [...request.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    if (typeof user === 'string' && /marker/i.test(user))
      return turn(
        '',
        [{ id: TOOL_CALL_ID, name: 'read_file', arguments: { path: 'marker.txt' } }],
        { inputTokens: 3, outputTokens: 0, cachedTokens: null, reasoningTokens: null },
        request.model.upstreamId,
      );
    // Reported zero output/cache, unreported reasoning: the nullable dimensions must survive.
    return turn(
      'READY',
      [],
      { inputTokens: 7, outputTokens: null, cachedTokens: 0, reasoningTokens: null },
      request.model.upstreamId,
    );
  };
  return (request) => Promise.resolve(decide(request));
}

interface CliHost {
  host: CoreHost;
  rpc: RpcFerryClient;
  services: FerryServices;
}

interface CliLifecycleHarness extends CliHost {
  root: string;
  workspaceDir: string;
  close(): Promise<void>;
}

interface StartCliHarnessOptions {
  /** Seed the global settings block. `false` exercises a cold, freshly-created data dir. */
  seedSettings?: boolean;
  scan?: CliConnectionServiceOptions['scan'];
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    FERRY_TEST_KEYRING_NAMESPACE: `ferry-cli-life-${String(process.pid)}`,
    FERRY_KEYRING_SERVICE: `Ferry-Cli-Life-${String(process.pid)}`,
  };
}

async function makeCliHost(
  dataDir: string,
  scan: (kind: CliConnectionKind) => Promise<CliConnection>,
  runTurn: CliTurnRunner,
  seedSettings: boolean,
): Promise<CliHost> {
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const cliUsage: CliConnectionServiceOptions['usage'] = (kind) =>
    Promise.resolve({ usage: emptyUsage(kind), account: null });
  const host = await createCoreHost({
    dataDir,
    transport: coreTransport,
    env: cliEnv(),
    cliScan: scan,
    cliUsage,
    cliRunTurn: runTurn,
  });
  const services = host.options.services;
  if (!services) throw new Error('Core services were not created');
  if (seedSettings) services.settings.put('global', sampleSettings);
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 60_000 });
  await rpc.hello;
  return { host, rpc, services };
}

async function startCliHarness(
  runTurn: CliTurnRunner,
  options: StartCliHarnessOptions = {},
): Promise<CliLifecycleHarness> {
  const root = await mkdtemp(join(tmpdir(), 'ferry-cli-life-'));
  const dataDir = join(root, 'data');
  const workspaceDir = join(root, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, 'marker.txt'), MARKER, 'utf8');
  const scan = options.scan ?? ((kind) => Promise.resolve(fixture(kind)));
  const { host, rpc, services } = await makeCliHost(
    dataDir,
    scan,
    runTurn,
    options.seedSettings ?? true,
  );
  const h: CliLifecycleHarness = {
    root,
    workspaceDir,
    host,
    rpc,
    services,
    async close() {
      rpc.close();
      try {
        await host.stop();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    },
  };
  harness = h;
  return h;
}

function assistantText(detail: SessionDetail): string {
  return detail.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n')
    .trim();
}

function errorsOf(detail: SessionDetail): string[] {
  return detail.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === 'error' ? [part.message] : [])),
  );
}

async function waitSettled(rpc: RpcFerryClient, sessionId: SessionId): Promise<SessionDetail> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const detail = await rpc.sessions.get(sessionId);
    const status = detail.session.status;
    if (!detail.session.inFlight && status !== 'running' && status !== 'awaiting_approval')
      return detail;
    if (Date.now() > deadline)
      throw new Error(`session ${sessionId} did not settle (status=${status})`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function usageRow(
  services: FerryServices,
  sessionId: string,
  modelRef: string,
): {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
} | null {
  return services.db.client
    .prepare(
      `SELECT input_tokens AS inputTokens, output_tokens AS outputTokens,
              cached_tokens AS cachedTokens, reasoning_tokens AS reasoningTokens
         FROM session_model_usage WHERE session_id=? AND model_ref=?`,
    )
    .get(sessionId, modelRef) as {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
  } | null;
}

for (const kind of KINDS) {
  it(`native lifecycle ${kind}: select, send, tool approval + real read, nullable usage`, async () => {
    const calls: CliBrokerRequest[] = [];
    const h = await startCliHarness(makeRunner(calls));
    const modelRef = `${kind}/${MODEL_ID[kind]}` as ModelRef;
    const connections = await h.rpc.cliConnections.refresh(kind);
    const connection = connections.find((entry) => entry.kind === kind);
    const model = connection?.models.find((entry) => entry.upstreamId === MODEL_ID[kind]);
    expect(connection?.account.state).toBe('signed_in');
    expect(model?.billing).toBe('included_subscription');
    // The discovered fixture reports no native context/output window.
    expect(model?.contextWindow ?? null).toBeNull();
    expect(model?.maxOutput ?? null).toBeNull();

    await h.rpc.cliConnections.update(kind, { surfaces: { native: true, gateway: true } });
    const verify = await h.rpc.cliConnections.verify(kind, modelRef);
    expect(verify.ok, verify.message).toBe(true);

    // Force read_file to require a genuine approval decision.
    await h.rpc.settings.update({
      permissionRules: [{ effect: 'ask', tool: 'read_file', pattern: '' }],
    });
    const approved: string[] = [];
    const off = h.rpc.on('approval.request', (event) => {
      approved.push(event.part.id);
      void h.rpc.approvals.respond(event.sessionId, event.part.id, 'allow_once');
    });

    const workspace = await h.rpc.workspaces.open(h.workspaceDir);
    await h.rpc.workspaces.trust(workspace.id);
    const session = await h.rpc.sessions.create({
      workspaceId: workspace.id,
      profileId: DIRECT_PROFILE_ID,
    });

    // The reported live bug: selecting a discovered CLI model must not throw "Unknown model".
    await h.rpc.models.select(session.id, modelRef);
    await h.rpc.sessions.updateCliOptions(session.id, {
      modelRef,
      options: { effort: 'low', speed: 'standard' },
    });

    // Stage 1: plain text with a partial usage record.
    await h.rpc.sessions.send(session.id, {
      text: 'Reply exactly READY and nothing else. Do not use any tools.',
    });
    const textDetail = await waitSettled(h.rpc, session.id);
    expect(errorsOf(textDetail)).toEqual([]);
    expect(assistantText(textDetail)).toBe('READY');
    // The exact fake `Ready` verification generation is excluded from the recorded calls.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model.ref).toBe(modelRef);

    // SQLite usage keeps reported zero and preserves unreported dimensions as NULL (never invented 0).
    const row = usageRow(h.services, session.id, modelRef);
    expect(row).not.toBeNull();
    expect(row?.inputTokens).toBe(7);
    expect(row?.outputTokens).toBeNull();
    expect(row?.cachedTokens).toBe(0);
    expect(row?.reasoningTokens).toBeNull();

    // Stage 2: a real caller tool round trip with approval.
    await h.rpc.sessions.send(session.id, {
      text: 'Read marker.txt through the caller file-reading tool. Reply with its complete content verbatim. Do not use native CLI tools.',
    });
    const toolDetail = await waitSettled(h.rpc, session.id);
    expect(errorsOf(toolDetail)).toEqual([]);
    const finalAssistant = toolDetail.messages
      .filter((message) => message.role === 'assistant')
      .at(-1);
    const finalText = (finalAssistant?.parts ?? [])
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim();
    expect(finalText).toContain(MARKER);
    expect(approved.length).toBeGreaterThanOrEqual(1);

    // The continuation proves the adapter received the REAL tool result and the original tool id.
    const continuation = calls.find((call) =>
      call.messages.some((message) => message.role === 'tool'),
    );
    const toolCallMessage = continuation?.messages.find(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
    );
    expect(toolCallMessage?.tool_calls?.[0]?.id).toBe(TOOL_CALL_ID);
    expect(toolCallMessage?.tool_calls?.[0]?.function.name).toBe('read_file');
    const toolMessage = continuation?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe(TOOL_CALL_ID);
    expect(String(toolMessage?.content)).toContain(MARKER);

    off();
  });
}

it('native: rejects a tool result carrying images before dispatch (no silent discard)', () => {
  const message: Message = {
    id: 'message_img' as Message['id'],
    sessionId: 'session_img' as Message['sessionId'],
    role: 'assistant',
    createdAt: new Date().toISOString(),
    modelRef: null,
    parts: [
      {
        type: 'tool_call',
        id: 'part_img' as MessagePart['id'],
        tool: 'check_page',
        title: 'Check a page',
        args: {},
        status: 'succeeded',
        durationMs: 1,
        changes: [],
        output: {
          text: 'captured',
          filtered: false,
          originalTokens: null,
          filteredTokens: null,
          recoveryHandle: null,
          images: [{ path: 'shot.png', data: 'AAAA', mimeType: 'image/png' }],
        },
      },
    ],
  };
  expect(unsupportedCliImageMessage([message])).toMatch(/image content/);
  expect(unsupportedCliImageMessage([])).toBeNull();
});

it('native lifecycle: cancellation aborts the turn and frees the connection queue', async () => {
  const calls: CliBrokerRequest[] = [];
  const base = makeRunner(calls);
  const runner: CliTurnRunner = async (request) => {
    const user = [...request.messages].reverse().find((message) => message.role === 'user');
    if (typeof user?.content === 'string' && /HANG/i.test(user.content))
      return await new Promise<CliTurnResult>((_resolve, reject) => {
        if (request.signal.aborted) {
          reject(new Error('cancelled'));
          return;
        }
        request.signal.addEventListener(
          'abort',
          () => {
            reject(new Error('cancelled'));
          },
          { once: true },
        );
      });
    return await base(request);
  };
  const h = await startCliHarness(runner);
  const kind: CliConnectionKind = 'codex-cli';
  const modelRef = `${kind}/${MODEL_ID[kind]}` as ModelRef;
  await h.rpc.cliConnections.refresh(kind);
  await h.rpc.cliConnections.update(kind, { surfaces: { native: true, gateway: true } });
  expect((await h.rpc.cliConnections.verify(kind, modelRef)).ok).toBe(true);
  const workspace = await h.rpc.workspaces.open(h.workspaceDir);
  await h.rpc.workspaces.trust(workspace.id);
  const session = await h.rpc.sessions.create({
    workspaceId: workspace.id,
    profileId: DIRECT_PROFILE_ID,
  });
  await h.rpc.models.select(session.id, modelRef);
  await h.rpc.sessions.send(session.id, { text: 'HANG for a while please.' });
  await h.rpc.sessions.cancel(session.id);
  const settled = await waitSettled(h.rpc, session.id);
  expect(settled.session.inFlight).toBe(false);

  // The cancelled turn released the single connection slot: a follow-up turn still runs.
  await h.rpc.sessions.send(session.id, { text: 'Reply exactly READY and nothing else.' });
  const after = await waitSettled(h.rpc, session.id);
  expect(assistantText(after)).toBe('READY');
});

it('cold fresh data dir: native opt-in needs no settings bootstrap or store seed', async () => {
  const calls: CliBrokerRequest[] = [];
  const scans: Record<CliConnectionKind, number> = {
    'codex-cli': 0,
    'claude-code-cli': 0,
    'opencode-cli': 0,
  };
  const scan = (kind: CliConnectionKind): Promise<CliConnection> => {
    scans[kind] += 1;
    return Promise.resolve(fixture(kind));
  };
  // seedSettings:false means no settings.get/update and no direct SQL/store seed happened first.
  const h = await startCliHarness(makeRunner(calls), { seedSettings: false, scan });
  const kind: CliConnectionKind = 'codex-cli';
  const other: CliConnectionKind = 'claude-code-cli';
  const otherRef = `${other}/${MODEL_ID[other]}` as ModelRef;

  // Opt in and verify the OTHER kind first so its opt-in/receipt must survive a single-kind refresh.
  await h.rpc.cliConnections.refresh(other);
  await h.rpc.cliConnections.update(other, { surfaces: { native: true, gateway: true } });
  expect((await h.rpc.cliConnections.verify(other, otherRef)).ok).toBe(true);
  const scansBefore = { ...scans };

  // Refreshing ONE kind probes only that kind but returns the FULL snapshot of all three.
  const refreshed = await h.rpc.cliConnections.refresh(kind);
  expect(refreshed.map((entry) => entry.kind).sort()).toEqual([...KINDS].sort());
  expect(refreshed.find((entry) => entry.kind === kind)?.account.state).toBe('signed_in');
  const otherNow = refreshed.find((entry) => entry.kind === other);
  expect(otherNow?.surfaces).toEqual({ native: true, gateway: true });
  expect(otherNow?.verify.modelReceipts?.[otherRef]).toBeTruthy();
  // Only the requested kind was freshly probed; the other kinds were not re-probed.
  expect(scans[kind]).toBe(scansBefore[kind] + 1);
  expect(scans[other]).toBe(scansBefore[other]);
  expect(scans['opencode-cli']).toBe(scansBefore['opencode-cli']);

  const updated = await h.rpc.cliConnections.update(kind, {
    surfaces: { native: true, gateway: true },
  });
  expect(updated.surfaces).toEqual({ native: true, gateway: true });

  // settings.get now reflects the choice, with full defaults materialized (not a wiped store).
  const settings = await h.rpc.settings.get();
  expect(settings.cliConnections[kind]).toMatchObject({ native: true, gateway: true });
  expect(settings.developer).toBeDefined();
  expect(settings.routing).toBeDefined();
  expect((await h.rpc.profiles.list()).length).toBeGreaterThan(0);

  // A later settings change and a chat survive a second CLI update (nothing is reset).
  await h.rpc.settings.update({ theme: 'light' });
  const session = await h.rpc.sessions.create({ profileId: DIRECT_PROFILE_ID });
  await h.rpc.cliConnections.update(kind, { defaultOptions: { effort: 'high' } });
  const after = await h.rpc.settings.get();
  expect(after.theme).toBe('light');
  expect(after.cliConnections[kind]?.defaultOptions.effort).toBe('high');
  expect((await h.rpc.sessions.list()).some((entry) => entry.id === session.id)).toBe(true);
});

it('per-model partial defaults round-trip through the settings RPC across a host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-cli-defaults-'));
  const dataDir = join(root, 'data');
  const scan = (kind: CliConnectionKind): Promise<CliConnection> =>
    Promise.resolve(
      fixture(
        kind,
        kind === 'codex-cli'
          ? [modelFor(kind, MODEL_ID[kind]), modelFor(kind, 'model-null')]
          : undefined,
      ),
    );
  const speedOnly = `codex-cli/${MODEL_ID['codex-cli']}` as ModelRef;
  const explicitNull = 'codex-cli/model-null' as ModelRef;
  const first = await makeCliHost(dataDir, scan, makeRunner([]), false);
  await first.rpc.cliConnections.refresh('codex-cli');
  await first.rpc.cliConnections.update('codex-cli', {
    defaultOptions: { effort: 'high' },
    modelDefaults: {
      [speedOnly]: { speed: 'standard' },
      [explicitNull]: { effort: null },
    },
  });
  first.rpc.close();
  await first.host.stop();

  const restarted = await makeCliHost(dataDir, scan, makeRunner([]), false);
  try {
    const settings = await restarted.rpc.settings.get();
    const saved = settings.cliConnections['codex-cli'];
    // The connection default is preserved (not reset to defaults) across the restart.
    expect(saved?.defaultOptions.effort).toBe('high');
    const speedOnlySaved = saved?.modelDefaults[speedOnly];
    // A speed-only patch stays speed-only: effort is absent, so it inherits the connection High.
    expect(speedOnlySaved).toEqual({ speed: 'standard' });
    expect(speedOnlySaved?.effort).toBeUndefined();
    // An explicit null is preserved as an intentional "use the CLI default" record.
    expect(saved?.modelDefaults[explicitNull]).toEqual({ effort: null });
  } finally {
    restarted.rpc.close();
    await restarted.host.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('per-model receipts revalidate on real RPC snapshots/events, persist and skip unchanged reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ferry-cli-reval-'));
  const dataDir = join(root, 'data');
  const workspaceDir = join(root, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const kind: CliConnectionKind = 'codex-cli';
  const a = `${kind}/model-a` as ModelRef;
  const b = `${kind}/model-b` as ModelRef;
  let bModel = modelFor(kind, 'model-b');
  let onlyA = false;
  const scan = (k: CliConnectionKind): Promise<CliConnection> =>
    Promise.resolve(
      fixture(
        k,
        k !== kind
          ? undefined
          : onlyA
            ? [modelFor(kind, 'model-a')]
            : [modelFor(kind, 'model-a'), bModel],
      ),
    );
  const runner = makeRunner([]);
  const first = await makeCliHost(dataDir, scan, runner, false);
  try {
    const events: CliConnection[] = [];
    const off = first.rpc.on('cliConnections.updated', (connection) => {
      if (connection.kind === kind) events.push(connection);
    });
    await first.rpc.cliConnections.refresh(kind);
    await first.rpc.cliConnections.update(kind, { surfaces: { native: true, gateway: true } });
    expect((await first.rpc.cliConnections.verify(kind, a)).ok).toBe(true);
    expect((await first.rpc.cliConnections.verify(kind, b)).ok).toBe(true);
    let connection = (await first.rpc.cliConnections.list()).find((entry) => entry.kind === kind);
    expect(connection?.verify.modelReceipts?.[a]).toBeTruthy();
    expect(connection?.verify.modelReceipts?.[b]).toBeTruthy();
    expect(
      (await first.rpc.models.list(cliProviderId(kind))).find((m) => m.ref === a)?.verified,
    ).toBe(true);
    expect(
      (await first.rpc.models.list(cliProviderId(kind))).find((m) => m.ref === b)?.verified,
    ).toBe(true);

    // Change ONLY B's effective capabilities (still discovered): its proof must drop and be persisted.
    bModel = modelFor(kind, 'model-b', { efforts: ['low', 'high', 'xhigh'] });
    events.length = 0;
    await first.rpc.cliConnections.refresh(kind);
    connection = (await first.rpc.cliConnections.list()).find((entry) => entry.kind === kind);
    expect(connection?.verify.modelReceipts?.[a]).toBeTruthy();
    expect(connection?.verify.modelReceipts?.[b]).toBeUndefined();
    expect(
      (await first.rpc.models.list(cliProviderId(kind))).find((m) => m.ref === a)?.verified,
    ).toBe(true);
    expect(
      (await first.rpc.models.list(cliProviderId(kind))).find((m) => m.ref === b)?.verified,
    ).toBe(false);
    // The change published an updated snapshot with only the surviving receipt.
    expect(
      events.some((event) => {
        const receipts = event.verify.modelReceipts ?? {};
        return receipts[a] !== undefined && receipts[b] === undefined;
      }),
    ).toBe(true);
    // Reading the now-stable cache does not re-emit duplicate updates.
    const emitted = events.length;
    await first.rpc.cliConnections.list();
    await first.rpc.cliConnections.list();
    await first.rpc.models.list(cliProviderId(kind));
    expect(events.length).toBe(emitted);

    // Removing B entirely keeps A verified and drops B from the snapshot.
    onlyA = true;
    await first.rpc.cliConnections.refresh(kind);
    connection = (await first.rpc.cliConnections.list()).find((entry) => entry.kind === kind);
    expect(connection?.verify.modelReceipts?.[a]).toBeTruthy();
    expect(connection?.verify.modelReceipts?.[b]).toBeUndefined();
    expect(connection?.models.some((m) => m.ref === b)).toBe(false);
    off();
  } finally {
    first.rpc.close();
    await first.host.stop();
  }

  // Restart against the same data dir: the surviving receipt was persisted, the dropped one was not.
  const restarted = await makeCliHost(dataDir, scan, runner, false);
  try {
    await restarted.rpc.cliConnections.refresh(kind);
    const connection = (await restarted.rpc.cliConnections.list()).find(
      (entry) => entry.kind === kind,
    );
    expect(connection?.verify.modelReceipts?.[a]).toBeTruthy();
    expect(connection?.verify.modelReceipts?.[b]).toBeUndefined();
    expect(
      (await restarted.rpc.models.list(cliProviderId(kind))).find((m) => m.ref === a)?.verified,
    ).toBe(true);
  } finally {
    restarted.rpc.close();
    await restarted.host.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
