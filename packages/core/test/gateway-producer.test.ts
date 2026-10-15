import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sampleSettings } from '@ferry/shared/testing';
import type { CliTurnResult } from '@ferry/delegate';
import type { FakeResponse } from '@ferry/testkit';
import type { StepGeneratorInput } from '@ferry/agent';
import {
  ModelInfoSchema,
  ModelRefSchema,
  type CliConnection,
  type CliConnectionKind,
  type CliModelCapabilities,
  type CliUsageSnapshot,
  type GatewayRequestRecord,
  type Message,
  type MessagePart,
  type ModelInfo,
  type ModelRef,
  type SessionId,
  type TraceContext,
  type UsageRecord,
} from '@ferry/shared';
import { getCliBroker, type CliBrokerRequest, type CliTurnRunner } from '../src/cli-broker.js';
import { getCliConnectionService } from '../src/cli-connections.js';
import { getGatewayController } from '../src/gateway.js';
import { createSessionDependencies, gatewayStepAttribution } from '../src/session-deps.js';
import { startHarness, waitFor, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });

/* ------------------------------ pure correlation ------------------------- */

const KEY_A = 'key-a';
const KEY_B = 'key-b';
const TRACE_A = 'ferry_aaa';
const TRACE_B = 'ferry_bbb';
const REQUESTED = ModelRefSchema.parse('gateway/key-a');
const MODEL_B = ModelRefSchema.parse('codex-cli/model-b');

function record(overrides: Partial<GatewayRequestRecord> = {}): GatewayRequestRecord {
  return {
    id: 'gwreq_1',
    at: '2026-01-01T00:00:00.000Z',
    keyId: KEY_A,
    keyName: 'Key A',
    requestedModel: 'gateway/key-a',
    modelRef: MODEL_B,
    providerId: 'codex-cli',
    status: 'ok',
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 1,
    error: null,
    outcome: 'completed',
    traceId: TRACE_A,
    servedModel: MODEL_B,
    servedProviderId: 'codex-cli',
    servedConnectionId: 'codex-cli',
    servedAccountKey: `codex-cli:${'a'.repeat(24)}`,
    ...overrides,
  };
}

it('correlates the exact trace id + key id among interleaved Gateway outcomes', () => {
  const interleaved: GatewayRequestRecord[] = [
    record({ id: 'gwreq_newer', keyId: KEY_B, traceId: TRACE_B, servedAccountKey: 'other' }),
    record({ id: 'gwreq_ours' }),
  ];
  const attributed = gatewayStepAttribution(interleaved, KEY_A, TRACE_A, REQUESTED);
  expect(attributed.producer).toEqual({
    modelRef: MODEL_B,
    providerId: 'codex-cli',
    connectionId: 'codex-cli',
    accountKey: `codex-cli:${'a'.repeat(24)}`,
    requestedModelRef: REQUESTED,
  });
  expect(attributed.reportedUsage).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
});

it('never attributes from a trace id that belongs to another Gateway key', () => {
  const interleaved: GatewayRequestRecord[] = [
    record({ id: 'gwreq_other', keyId: KEY_B, traceId: TRACE_B }),
    record({ id: 'gwreq_ours', traceId: TRACE_A }),
  ];
  const matched = gatewayStepAttribution(interleaved, KEY_B, TRACE_B, REQUESTED);
  const wrongKey = gatewayStepAttribution(interleaved, KEY_B, TRACE_A, REQUESTED);
  expect(matched.producer?.accountKey).toBe(`codex-cli:${'a'.repeat(24)}`);
  expect(wrongKey.producer).toBeUndefined();
});

it('maps every reported usage dimension exactly, preserving a reported zero', () => {
  const attributed = gatewayStepAttribution(
    [
      record({
        reportedUsage: { inputTokens: 10, outputTokens: 0, cachedTokens: 0, reasoningTokens: 7 },
        usageReported: true,
      }),
    ],
    KEY_A,
    TRACE_A,
    REQUESTED,
  );
  expect(attributed.reportedUsage).toEqual({
    inputTokens: 10,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 7,
  });
});

it('keeps a partial or missing usage dimension null instead of fabricating a zero', () => {
  expect(
    gatewayStepAttribution(
      [record({ reportedUsage: undefined, usageReported: false })],
      KEY_A,
      TRACE_A,
      REQUESTED,
    ).reportedUsage,
  ).toEqual({ inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null });
  expect(
    gatewayStepAttribution(
      [
        record({
          reportedUsage: {
            inputTokens: 3,
            outputTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
          },
        }),
      ],
      KEY_A,
      TRACE_A,
      REQUESTED,
    ).reportedUsage,
  ).toEqual({ inputTokens: 3, outputTokens: null, cachedTokens: null, reasoningTokens: null });
});

it('ignores coalesced API zeros when the outcome explicitly reports no usage', () => {
  const attributed = gatewayStepAttribution(
    [
      record({
        reportedUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
        usageReported: false,
        upstreamUsageId: 'gateway:gwreq_1',
      }),
    ],
    KEY_A,
    TRACE_A,
    REQUESTED,
  );
  expect(attributed.reportedUsage).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  // The exact API event id is still surfaced so the consumer can re-record the one provider event.
  expect(attributed.upstreamUsageId).toBe('gateway:gwreq_1');
});

it('surfaces the exact API event id alongside a genuine reported zero', () => {
  const attributed = gatewayStepAttribution(
    [
      record({
        reportedUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: null,
          reasoningTokens: null,
        },
        usageReported: true,
        upstreamUsageId: 'gwreq_2:1',
      }),
    ],
    KEY_A,
    TRACE_A,
    REQUESTED,
  );
  expect(attributed.reportedUsage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    reasoningTokens: null,
  });
  expect(attributed.upstreamUsageId).toBe('gwreq_2:1');
});

it('stays honestly unknown for a missing, non-completed or unkeyed outcome', () => {
  expect(gatewayStepAttribution([], KEY_A, TRACE_A, REQUESTED).producer).toBeUndefined();
  expect(gatewayStepAttribution([], KEY_A, TRACE_A, REQUESTED).reportedUsage).toEqual({
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
  });
  // A cancelled/partial outcome is never presented as a completed producer.
  expect(
    gatewayStepAttribution(
      [record({ outcome: 'cancelled', servedAccountKey: null })],
      KEY_A,
      TRACE_A,
      REQUESTED,
    ).producer,
  ).toBeUndefined();
  // A retained record without concrete producer evidence stays unknown rather than guessed.
  expect(
    gatewayStepAttribution([record({ servedProviderId: null })], KEY_A, TRACE_A, REQUESTED)
      .producer,
  ).toBeUndefined();
  // No trace captured at all (e.g. the Gateway never answered) is unknown.
  expect(gatewayStepAttribution([record()], KEY_A, null, REQUESTED).producer).toBeUndefined();
});

/* ------------------------------ integration seams ------------------------ */

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

function cliModel(
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
    speeds: ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    contextWindow: 200_000,
    maxOutput: 8_192,
    billing: 'free',
    hidden: false,
    ...overrides,
  };
}

function connection(
  kind: CliConnectionKind,
  models: CliModelCapabilities[],
  accountKey = `${kind}:${'a'.repeat(24)}`,
): CliConnection {
  return {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: null,
    install: { installed: true, executable: kind, version: '1.0.0', installHint: '' },
    account: { state: 'signed_in', key: accountKey, label: null, plan: null },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models,
    usage: emptyUsage(kind),
    lastChecked: null,
    discoveryMessage: null,
  };
}

function answer(text: string, usage?: Partial<CliTurnResult['usage']>): CliTurnResult {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      ...(usage ?? {}),
    },
    responseModel: 'actual-model',
  };
}

const isVerify = (request: CliBrokerRequest): boolean =>
  request.messages.some(
    (message) =>
      typeof message.content === 'string' && message.content.includes('Reply with exactly Ready'),
  );

async function startCliHarness(options: {
  connections: Record<CliConnectionKind, CliConnection>;
  runner: CliTurnRunner;
}): Promise<{ h: CoreHarness; calls: CliBrokerRequest[] }> {
  const calls: CliBrokerRequest[] = [];
  const started = await startHarness({
    cliScan: (kind) => Promise.resolve(options.connections[kind]),
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn: async (request) => {
      if (isVerify(request))
        return {
          text: 'Ready',
          toolCalls: [],
          usage: {
            inputTokens: null,
            outputTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
          },
          responseModel: 'actual',
        };
      calls.push(request);
      return options.runner(request);
    },
  });
  started.services.settings.put('global', sampleSettings);
  harness = started;
  return { h: started, calls };
}

async function enableAndVerify(
  h: CoreHarness,
  kind: CliConnectionKind,
  ref: ModelRef,
): Promise<void> {
  const emit = (): void => undefined;
  const service = getCliConnectionService(h.services, emit);
  await service.refresh(kind);
  service.update(kind, { surfaces: { native: true, gateway: true } });
  const result = await getCliBroker(h.services, emit).verify(kind, ref);
  expect(result.ok, result.message).toBe(true);
}

async function startKey(
  h: CoreHarness,
  name: string,
  allowedModels: readonly ModelRef[],
): Promise<{ controller: NonNullable<ReturnType<typeof getGatewayController>>; keyId: string }> {
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey(name, 'none');
  controller.updateKey(created.key.id, { allowedModels: [...allowedModels] });
  return { controller, keyId: created.key.id };
}

async function waitIdle(h: CoreHarness, sessionId: SessionId): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const detail = await h.rpc.sessions.get(sessionId);
    const status = detail.session.status;
    if (status === 'idle') return;
    if (status === 'error') {
      const failure = detail.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'error');
      throw new Error(
        `session errored: ${failure && 'message' in failure ? failure.message : 'unknown'}`,
      );
    }
    if (Date.now() > deadline) throw new Error(`session did not idle: ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type TextPart = Extract<MessagePart, { type: 'text' }>;

function textParts(messages: { parts: MessagePart[] }[]): TextPart[] {
  return messages.flatMap((message) =>
    message.parts.filter((part): part is TextPart => part.type === 'text'),
  );
}

/** Text parts that carry a captured producer, narrowed so `producedBy` is readable. */
function producedParts(
  messages: { parts: MessagePart[] }[],
): (TextPart & { producedBy: ModelRef })[] {
  return textParts(messages).filter(
    (part): part is TextPart & { producedBy: ModelRef } => part.producedBy !== undefined,
  );
}

/* --------------- native CLI routed through an internal Gateway key ------- */

it('attributes a Gateway CLI step to its actual model/account captured before the await', async () => {
  const ref = 'codex-cli/model-b' as ModelRef;
  const accountA = `codex-cli:${'a'.repeat(24)}`;
  const accountC = `codex-cli:${'c'.repeat(24)}`;
  const conn = connection('codex-cli', [cliModel('codex-cli', 'model-b')], accountA);
  const { h } = await startCliHarness({
    connections: {
      'codex-cli': conn,
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    runner: (request) => {
      const last = request.messages.at(-1);
      if (last?.role === 'tool') {
        // The CLI account rotates underneath the connection while the run is in flight: the current
        // account is now C, but the completed step was dispatched from A.
        conn.account.key = accountC;
        request.onText?.('finished');
        return Promise.resolve(
          answer('finished', {
            inputTokens: 10,
            outputTokens: 4,
            cachedTokens: 0,
            reasoningTokens: 7,
          }),
        );
      }
      return Promise.resolve({
        text: '',
        toolCalls: [{ id: 'call_gw', name: 'read_file', arguments: { path: 'marker.txt' } }],
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
        responseModel: 'actual',
      });
    },
  });
  await writeFile(join(h.workspacePath, 'marker.txt'), 'REAL-RESULT', 'utf8');
  await h.rpc.settings.update({ permissionMode: 'full_auto' });
  await enableAndVerify(h, 'codex-cli', ref);
  const { controller, keyId } = await startKey(h, 'cli key', [ref]);

  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${keyId}`));
  await h.rpc.sessions.send(session.id, { text: 'read the marker then answer' });
  await waitIdle(h, session.id);

  const detail = await h.rpc.sessions.get(session.id);
  // The captured producer is the actual CLI model, never the logical gateway key.
  const produced = producedParts(detail.messages);
  expect(produced.length).toBeGreaterThan(0);
  expect(produced.every((part) => part.producedBy === ref)).toBe(true);
  expect(produced.some((part) => part.producedBy === `gateway/${keyId}`)).toBe(false);
  // The requested logical ref and the pin are preserved.
  expect(detail.session.pinnedModelRef).toBe(`gateway/${keyId}`);
  expect(detail.messages.some((message) => message.requestedModelRef === `gateway/${keyId}`)).toBe(
    true,
  );

  // The durable Gateway outcome pairs the exact trace id with the dispatch-captured account A.
  const records = controller.requests().filter((entry) => entry.keyId === keyId);
  expect(records.length).toBeGreaterThanOrEqual(2);
  for (const entry of records) {
    expect(entry.servedProviderId).toBe('codex-cli');
    expect(entry.servedConnectionId).toBe('codex-cli');
    expect(entry.servedAccountKey).toBe(accountA);
    expect(entry.outcome).toBe('completed');
  }
  const usageRecord = records.find((entry) => entry.reportedUsage?.inputTokens === 10);
  expect(usageRecord?.reportedUsage).toEqual({
    inputTokens: 10,
    outputTokens: 4,
    cachedTokens: 0,
    reasoningTokens: 7,
  });

  // Session model usage attributes the step to the captured producer, preserving zero dimensions.
  const usage = await h.rpc.sessions.modelUsage(session.id);
  const row = usage.models.find((model) => model.modelRef === ref);
  expect(row).toMatchObject({
    providerId: 'codex-cli',
    connectionId: 'codex-cli',
    accountKey: accountA,
    inputTokens: 10,
    outputTokens: 4,
    cachedTokens: 0,
    reasoningTokens: 7,
  });
  // The current account has rotated to C underneath the connection.
  expect(conn.account.key).toBe(accountC);
});

it('keeps two interleaved Gateway keys exactly correlated to their own routes', async () => {
  const codexRef = 'codex-cli/model-b' as ModelRef;
  const opencodeRef = 'opencode-cli/model-d' as ModelRef;
  const { h } = await startCliHarness({
    connections: {
      'codex-cli': connection('codex-cli', [cliModel('codex-cli', 'model-b')]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', [cliModel('opencode-cli', 'model-d')]),
    },
    runner: (request) => {
      const text = `served:${request.model.ref}`;
      request.onText?.(text);
      return Promise.resolve(answer(text));
    },
  });
  await enableAndVerify(h, 'codex-cli', codexRef);
  await enableAndVerify(h, 'opencode-cli', opencodeRef);
  const codexKey = await startKey(h, 'codex key', [codexRef]);
  const opencodeKey = await startKey(h, 'opencode key', [opencodeRef]);

  const codexSession = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  const opencodeSession = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(codexSession.id, ModelRefSchema.parse(`gateway/${codexKey.keyId}`));
  await h.rpc.models.select(
    opencodeSession.id,
    ModelRefSchema.parse(`gateway/${opencodeKey.keyId}`),
  );
  await Promise.all([
    h.rpc.sessions.send(codexSession.id, { text: 'one' }),
    h.rpc.sessions.send(opencodeSession.id, { text: 'two' }),
  ]);
  await Promise.all([waitIdle(h, codexSession.id), waitIdle(h, opencodeSession.id)]);

  const codexDetail = await h.rpc.sessions.get(codexSession.id);
  const opencodeDetail = await h.rpc.sessions.get(opencodeSession.id);
  const codexProduced = producedParts(codexDetail.messages);
  const opencodeProduced = producedParts(opencodeDetail.messages);
  expect(codexProduced.length).toBeGreaterThan(0);
  expect(opencodeProduced.length).toBeGreaterThan(0);
  expect(codexProduced.every((part) => part.producedBy === codexRef)).toBe(true);
  expect(opencodeProduced.every((part) => part.producedBy === opencodeRef)).toBe(true);
  expect(
    codexKey.controller.requests().filter((entry) => entry.keyId === codexKey.keyId),
  ).toHaveLength(1);
  expect(
    opencodeKey.controller.requests().filter((entry) => entry.keyId === opencodeKey.keyId),
  ).toHaveLength(1);
});

it('stays honestly unknown when the completed Gateway outcome is no longer retained', async () => {
  const ref = 'codex-cli/model-b' as ModelRef;
  const { h } = await startCliHarness({
    connections: {
      'codex-cli': connection('codex-cli', [cliModel('codex-cli', 'model-b')]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    runner: (request) => {
      request.onText?.('served');
      return Promise.resolve(answer('served'));
    },
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const { controller, keyId } = await startKey(h, 'cli key', [ref]);
  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${keyId}`));
  // Simulate the request log being out of retention: no outcome can be correlated.
  const requests = vi.spyOn(controller, 'requests').mockReturnValue([]);
  try {
    await h.rpc.sessions.send(session.id, { text: 'answer' });
    await waitIdle(h, session.id);
  } finally {
    requests.mockRestore();
  }
  const detail = await h.rpc.sessions.get(session.id);
  const served = textParts(detail.messages).find((part) => part.text === 'served');
  expect(served).toBeTruthy();
  // No guessed attribution: the answer is retained but the logical gateway ref is never a producer.
  expect('producedBy' in (served ?? {})).toBe(false);
  const usage = await h.rpc.sessions.modelUsage(session.id);
  expect(usage.models.every((model) => model.providerId !== 'codex-cli')).toBe(true);
});

it('never reuses a prior turn attribution after a cancelled Gateway generation', async () => {
  const ref = 'codex-cli/model-b' as ModelRef;
  let generations = 0;
  const { h } = await startCliHarness({
    connections: {
      'codex-cli': connection('codex-cli', [cliModel('codex-cli', 'model-b')]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    runner: (request) => {
      generations += 1;
      if (generations === 1) {
        request.onText?.('first answer');
        return Promise.resolve(answer('first answer', { inputTokens: 5, outputTokens: 2 }));
      }
      // The second generation hangs until the run is cancelled.
      return new Promise<CliTurnResult>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    },
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const { keyId } = await startKey(h, 'cli key', [ref]);
  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${keyId}`));
  await h.rpc.sessions.send(session.id, { text: 'first' });
  await waitIdle(h, session.id);
  expect((await h.rpc.sessions.modelUsage(session.id)).totals.requests).toBe(1);

  await h.rpc.sessions.send(session.id, { text: 'second' });
  await waitFor(() => generations >= 2);
  await h.rpc.sessions.cancel(session.id);
  await waitIdle(h, session.id);

  // The cancelled turn contributes no attributed usage and reuses nothing from the first turn.
  expect((await h.rpc.sessions.modelUsage(session.id)).totals.requests).toBe(1);
  const produced = producedParts((await h.rpc.sessions.get(session.id)).messages);
  expect(produced.length).toBeGreaterThan(0);
  expect(produced.every((part) => part.producedBy === ref)).toBe(true);
});

it('attributes a Gateway standard-API route to the actual upstream model', async () => {
  const h = await startHarness();
  try {
    const model = h.services.models.list('openrouter').find((candidate) => candidate.toolCalling);
    if (!model) throw new Error('missing openrouter fixture');
    const controller = getGatewayController(h.services);
    if (!controller) throw new Error('gateway controller missing');
    await controller.start({ enabled: true, port: 0, allowLan: false });
    const created = controller.createKey('api key', 'none');
    controller.updateKey(created.key.id, { allowedModels: [model.ref] });

    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${created.key.id}`));
    await h.rpc.sessions.send(session.id, { text: 'hello' });
    await waitIdle(h, session.id);

    const detail = await h.rpc.sessions.get(session.id);
    const produced = producedParts(detail.messages);
    expect(produced.length).toBeGreaterThan(0);
    expect(produced.every((part) => part.producedBy === model.ref)).toBe(true);
    const records = controller.requests().filter((entry) => entry.keyId === created.key.id);
    expect(records[0]?.servedProviderId).toBe('openrouter');
    expect(records[0]?.servedConnectionId).toBeNull();
    expect(records[0]?.servedAccountKey).toBeNull();
  } finally {
    await h.close();
  }
});

/* -------------------- native API routed through a Gateway key ------------ */

function apiChunk(
  delta: Record<string, unknown>,
  finish: string | null = null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl_api',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function withUsage(
  chunk: Record<string, unknown>,
  usage: { prompt_tokens: number; completion_tokens: number },
): Record<string, unknown> {
  return {
    ...chunk,
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

/** A streamed API answer carrying reported usage (or none, to signal an unreported outcome). */
function apiTurn(
  text: string,
  usage?: { prompt_tokens: number; completion_tokens: number },
): FakeResponse {
  const words = text.match(/\S+\s*/g) ?? [text];
  const stop = apiChunk({}, 'stop');
  return {
    chunks: [
      apiChunk({ role: 'assistant' }),
      ...words.map((word) => apiChunk({ content: word })),
      usage ? withUsage(stop, usage) : stop,
    ],
  };
}

/** A streamed API tool-call answer, optionally reporting usage on its final chunk. */
function apiToolTurn(
  name: string,
  args: Record<string, unknown>,
  usage?: { prompt_tokens: number; completion_tokens: number },
): FakeResponse {
  return {
    chunks: [
      apiChunk({ role: 'assistant' }),
      apiChunk({
        tool_calls: [
          { index: 0, id: 'call_api_1', type: 'function', function: { name, arguments: '' } },
        ],
      }),
      apiChunk({
        tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(args) } }],
      }),
      usage ? withUsage(apiChunk({}, 'tool_calls'), usage) : apiChunk({}, 'tool_calls'),
    ],
  };
}

async function gatewayKeyFor(
  h: CoreHarness,
  modelRef: ModelRef,
  paid?: { budgetUsd: number },
): Promise<{ controller: NonNullable<ReturnType<typeof getGatewayController>>; keyId: string }> {
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey(paid ? 'paid key' : 'api key', 'none');
  controller.updateKey(created.key.id, {
    allowedModels: [modelRef],
    ...(paid ? { paidBackup: true, budgetUsd: paid.budgetUsd } : {}),
  });
  return { controller, keyId: created.key.id };
}

it('records one provider and one conversation event per native-via-Gateway API generation', async () => {
  const h = await startHarness({
    turns: [
      apiToolTurn('read_file', { path: 'marker.txt' }, { prompt_tokens: 12, completion_tokens: 8 }),
      apiTurn('done', { prompt_tokens: 5, completion_tokens: 2 }),
    ],
  });
  try {
    await writeFile(join(h.workspacePath, 'marker.txt'), 'REAL-RESULT', 'utf8');
    await h.rpc.settings.update({ permissionMode: 'full_auto' });
    const model = h.services.models.list('openrouter').find((candidate) => candidate.toolCalling);
    if (!model) throw new Error('missing openrouter fixture');
    const { controller, keyId } = await gatewayKeyFor(h, model.ref);

    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${keyId}`));
    await h.rpc.sessions.send(session.id, { text: 'read then answer' });
    await waitIdle(h, session.id);

    // Gateway history is independent and each API generation exposes its exact quota event id.
    const records = controller.requests().filter((entry) => entry.keyId === keyId);
    expect(records).toHaveLength(2);
    expect(records.every((entry) => typeof entry.upstreamUsageId === 'string')).toBe(true);

    const usage = await h.rpc.sessions.modelUsage(session.id);
    expect(usage.models.find((entry) => entry.modelRef === model.ref)).toMatchObject({
      providerId: 'openrouter',
      requests: 2,
      inputTokens: 17,
      outputTokens: 10,
    });

    // Exactly one provider record per generation, and it is the SAME event the conversation now
    // attributes; nothing is left under the logical `gateway` provider.
    const provider = h.services.quota.queryUsage({ providerId: 'openrouter' });
    expect(provider).toHaveLength(2);
    expect(provider.every((entry) => entry.sessionId === session.id)).toBe(true);
    expect(new Set(provider.map((entry) => entry.id))).toEqual(
      new Set(records.map((entry) => entry.upstreamUsageId)),
    );
    expect(h.services.quota.queryUsage({ providerId: 'gateway' })).toHaveLength(0);
  } finally {
    await h.close();
  }
});

it('treats an explicitly unreported API outcome as unknown, not a reported zero', async () => {
  const h = await startHarness({ turns: [apiTurn('no usage')] });
  try {
    const model = h.services.models.list('openrouter').find((candidate) => candidate.toolCalling);
    if (!model) throw new Error('missing openrouter fixture');
    const { controller, keyId } = await gatewayKeyFor(h, model.ref);

    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${keyId}`));
    await h.rpc.sessions.send(session.id, { text: 'answer without usage' });
    await waitIdle(h, session.id);

    // The Gateway coalesces an unreported API outcome to a `usageReported: false` outcome.
    expect(controller.requests().find((entry) => entry.keyId === keyId)?.usageReported).toBe(false);
    const quota = h.services.quota.queryUsage({ sessionId: session.id });
    expect(quota).toHaveLength(1);
    // All-null source usage: the coalesced zeros are not surfaced as real reported tokens.
    expect(quota[0]?.inputTokens).toBeUndefined();
    expect(quota[0]?.outputTokens).toBeUndefined();
  } finally {
    await h.close();
  }
});

it('keeps a genuine CLI reported zero distinct from an unreported dimension', async () => {
  const ref = 'codex-cli/model-b' as ModelRef;
  const { h } = await startCliHarness({
    connections: {
      'codex-cli': connection('codex-cli', [cliModel('codex-cli', 'model-b')]),
      'claude-code-cli': connection('claude-code-cli', []),
      'opencode-cli': connection('opencode-cli', []),
    },
    runner: (request) => {
      request.onText?.('zero');
      return Promise.resolve(answer('zero', { inputTokens: 0, outputTokens: 0 }));
    },
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const { controller, keyId } = await startKey(h, 'cli key', [ref]);
  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${keyId}`));
  await h.rpc.sessions.send(session.id, { text: 'answer with a real zero' });
  await waitIdle(h, session.id);

  // A CLI route reports the zero explicitly: `usageReported` is true, so the zero is real.
  expect(controller.requests().find((entry) => entry.keyId === keyId)?.usageReported).toBe(true);
  const quota = h.services.quota.queryUsage({ sessionId: session.id });
  expect(quota).toHaveLength(1);
  expect(quota[0]?.inputTokens).toBe(0);
  expect(quota[0]?.outputTokens).toBe(0);
  expect(
    (await h.rpc.sessions.modelUsage(session.id)).models.find((entry) => entry.modelRef === ref)
      ?.unreportedRequests,
  ).toBe(0);
});

it('preserves a paid native-via-Gateway API charge without a duplicate reservation', async () => {
  const h = await startHarness({
    turns: [apiTurn('paid', { prompt_tokens: 12, completion_tokens: 8 })],
  });
  try {
    const template = h.services.catalog.models.find(
      (candidate) => candidate.providerId === 'openrouter' && candidate.toolCalling,
    );
    if (!template) throw new Error('missing openrouter template');
    const model = ModelInfoSchema.parse({
      ...template,
      ref: 'openrouter/native-paid',
      free: false,
      priceInPerM: 1000,
      priceOutPerM: 1000,
      maxOutput: 100,
    });
    h.services.models.replace('openrouter', [model]);
    // The reservation is bounded by the full prompt estimate, so the key cap must clear it while the
    // actual charge stays tiny (12/8 reported tokens).
    const { controller, keyId } = await gatewayKeyFor(h, model.ref, { budgetUsd: 100 });

    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    await h.rpc.models.select(session.id, ModelRefSchema.parse(`gateway/${keyId}`));
    await h.rpc.sessions.send(session.id, { text: 'paid answer' });
    await waitIdle(h, session.id);

    const record = controller.requests().find((entry) => entry.keyId === keyId);
    expect(record?.status).toBe('ok');
    const quota = h.services.quota.queryUsage({ providerId: 'openrouter' });
    expect(quota).toHaveLength(1);
    // The re-record reuses the exact charged event and keeps its cost rather than inventing one.
    expect(quota[0]?.id).toBe(record?.upstreamUsageId);
    expect(quota[0]?.costUsd).toBe(record?.costUsd);
    expect(quota[0]?.costUsd).toBeGreaterThan(0);
    expect(quota[0]?.sessionId).toBe(session.id);
    // One settled charge, no unsettled (or duplicate) reservation left behind.
    expect(
      h.services.db.client.prepare('SELECT count(*) AS total FROM spend_reservations').get(),
    ).toEqual({ total: 0 });
    expect(
      h.services.db.client.prepare('SELECT count(*) AS total FROM spend_charges').get(),
    ).toEqual({ total: 1 });
    expect((await h.rpc.sessions.modelUsage(session.id)).totals.requests).toBe(1);
  } finally {
    await h.close();
  }
});

/* ---------------- step-level guards for per-step event correlation ------- */

function gatewayModel(keyId: string, keyName: string, modelName: string): ModelInfo {
  return {
    ref: `gateway/${keyId}` as ModelRef,
    providerId: 'gateway' as ModelInfo['providerId'],
    name: keyName,
    tier: 'T1',
    contextWindow: 128_000,
    maxOutput: 8_192,
    toolCalling: true,
    reasoning: false,
    free: false,
    priceInPerM: null,
    priceOutPerM: null,
    gateway: { keyId, keyName, modelName },
  };
}

function stepInput(model: ModelInfo, sessionId: string): StepGeneratorInput {
  const controller = new AbortController();
  const message: Message = {
    id: 'msg_guard' as Message['id'],
    sessionId: sessionId as Message['sessionId'],
    role: 'user',
    createdAt: new Date().toISOString(),
    modelRef: null,
    parts: [{ type: 'text', id: 'part_guard' as MessagePart['id'], text: 'hi' }],
  };
  return {
    model,
    system: 'You are Ferry.',
    messages: [message],
    tools: [],
    signal: controller.signal,
    onDelta: () => undefined,
    modelHints: { toolProtocol: 'native', editFormat: 'search_replace' },
  };
}

function traceFor(sessionId: string): TraceContext {
  return { traceId: 'trace_guard', sessionId, deviceId: 'device', appVersion: '0.0.0' };
}

it('a skipped Gateway usage consumer cannot lend its event id to a later direct generation', async () => {
  const h = await startHarness({
    turns: [
      apiTurn('gateway answer', { prompt_tokens: 4, completion_tokens: 2 }),
      apiTurn('direct answer'),
    ],
  });
  try {
    const model = h.services.models.list('openrouter').find((candidate) => candidate.toolCalling);
    if (!model) throw new Error('missing openrouter fixture');
    const { controller, keyId } = await gatewayKeyFor(h, model.ref);
    const sessionId = 'sess_stale';
    const runtime = createSessionDependencies(h.services, () => undefined, traceFor(sessionId));

    // Step 1: a Gateway API generation sets the pending correlation, but its usage consumer is skipped.
    const gwInput = stepInput(gatewayModel(keyId, 'api key', model.ref), sessionId);
    await runtime.gateway.streamStep(gwInput, gwInput.signal);
    const upstreamUsageId =
      controller.requests().find((entry) => entry.keyId === keyId)?.upstreamUsageId ?? null;
    if (upstreamUsageId === null) throw new Error('missing gateway upstream usage id');

    // Step 2: a direct API generation clears the pending id at the start of streamStep, so its own
    // usage record keeps its own event id.
    const directInput = stepInput(model, sessionId);
    const direct = await runtime.gateway.streamStep(directInput, directInput.signal);
    expect(direct.text).toBe('direct answer');
    runtime.usage.record({
      id: 'usage_direct_step',
      providerId: model.providerId,
      modelRef: model.ref,
      occurredAt: new Date().toISOString(),
      status: 'success',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(h.services.quota.getUsage('usage_direct_step')?.id).toBe('usage_direct_step');
    // The Gateway event keeps its own attribution (no session) rather than being stolen/overwritten.
    const gatewayEvent = h.services.quota.getUsage(upstreamUsageId);
    expect(gatewayEvent?.id).toBe(upstreamUsageId);
    expect(gatewayEvent?.sessionId).toBeUndefined();
  } finally {
    await h.close();
  }
});

it('does not inherit a conversation recomputed cost when the original event metadata is gone', async () => {
  const h = await startHarness({
    turns: [apiTurn('gateway answer', { prompt_tokens: 4, completion_tokens: 2 })],
  });
  try {
    const model = h.services.models.list('openrouter').find((candidate) => candidate.toolCalling);
    if (!model) throw new Error('missing openrouter fixture');
    const { controller, keyId } = await gatewayKeyFor(h, model.ref);
    const sessionId = 'sess_missing';
    const runtime = createSessionDependencies(h.services, () => undefined, traceFor(sessionId));
    const gwInput = stepInput(gatewayModel(keyId, 'api key', model.ref), sessionId);
    await runtime.gateway.streamStep(gwInput, gwInput.signal);
    const upstreamUsageId =
      controller.requests().find((entry) => entry.keyId === keyId)?.upstreamUsageId ?? null;
    if (upstreamUsageId === null) throw new Error('missing gateway upstream usage id');

    // The original provider event is no longer retained: an exact lookup miss.
    const recorded: UsageRecord[] = [];
    const getUsage = vi.spyOn(h.services.quota, 'getUsage').mockReturnValue(undefined);
    const recordUsage = vi.spyOn(h.services.quota, 'recordUsage').mockImplementation((entry) => {
      recorded.push(entry);
    });
    try {
      runtime.usage.record({
        id: 'usage_conversation',
        providerId: model.providerId,
        modelRef: model.ref,
        occurredAt: new Date().toISOString(),
        sessionId,
        status: 'success',
        inputTokens: 4,
        outputTokens: 2,
        costUsd: 0.01,
        headers: { costEstimate: 'conservative-unknown-price' },
      });
    } finally {
      getUsage.mockRestore();
      recordUsage.mockRestore();
    }

    // The exact event id is kept for dedup, but the invented cost/plan/headers are not carried over.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.id).toBe(upstreamUsageId);
    expect(recorded[0]?.costUsd).toBeUndefined();
    expect(recorded[0]?.planUnits).toBeUndefined();
    expect(recorded[0]?.headers).toBeUndefined();
    expect(recorded[0]?.inputTokens).toBe(4);
    expect(recorded[0]?.sessionId).toBe(sessionId);
  } finally {
    await h.close();
  }
});
