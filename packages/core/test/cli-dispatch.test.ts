import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BUILTIN_PROFILES } from '@ferry/router';
import { sampleSettings } from '@ferry/shared/testing';
import {
  newId,
  type CliConnection,
  type CliConnectionKind,
  type CliModelCapabilities,
} from '@ferry/shared';
import type { CliTurnResult } from '@ferry/delegate';
import { OpenCodeAcpError } from '@ferry/delegate';
import type { ModelInfo, ModelRef, Message, MessagePart } from '@ferry/shared';
import type { AgentTool, GeneratedStep, StepGeneratorInput } from '@ferry/agent';
import {
  CliBroker,
  cliManualAdmission,
  getCliBroker,
  type CliTurnRunner,
} from '../src/cli-broker.js';
import { getCliConnectionService } from '../src/cli-connections.js';
import { createSessionDependencies } from '../src/session-deps.js';
import { migrateLegacyZenCliConnection } from '../src/services.js';
import { getGatewayController } from '../src/gateway.js';
import { startHarness, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });

const KINDS: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
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
    contextWindow: 200_000,
    maxOutput: 8_192,
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

function ready(text: string, usage?: Partial<CliTurnResult['usage']>): CliTurnResult {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      ...usage,
    },
    responseModel: 'actual-model',
  };
}

async function setup(
  runnerImpl: CliTurnRunner,
  modelsByKind?: Partial<Record<CliConnectionKind, CliModelCapabilities[]>>,
): Promise<{
  h: CoreHarness;
  runner: { calls: Parameters<CliTurnRunner>[0][]; impl: CliTurnRunner };
}> {
  const fixtures = Object.fromEntries(
    KINDS.map((kind) => [kind, connection(kind, modelsByKind?.[kind] ?? [model(kind, 'model-a')])]),
  ) as Record<CliConnectionKind, CliConnection>;
  const runner = { calls: [] as Parameters<CliTurnRunner>[0][], impl: runnerImpl };
  const cliRunTurn: CliTurnRunner = async (request) => {
    // The one bounded verification prompt always succeeds so a test can verify then swap behaviour.
    if (
      request.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('Reply with exactly Ready'),
      )
    ) {
      request.onText?.('Ready');
      return ready('Ready');
    }
    runner.calls.push(request);
    const result = await runner.impl(request);
    if (result.text) request.onText?.(result.text);
    return result;
  };
  harness = await startHarness({
    cliScan: (kind) => Promise.resolve(fixtures[kind]),
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn,
  });
  // Seed the global settings block the connection service reads for surfaces and defaults.
  harness.services.settings.put('global', sampleSettings);
  return { h: harness, runner };
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

function userMessage(text: string, sessionId = 'sess_test'): Message {
  return {
    id: newId('msg') as Message['id'],
    sessionId: sessionId as Message['sessionId'],
    role: 'user',
    createdAt: new Date().toISOString(),
    modelRef: null,
    parts: [{ type: 'text', id: newId('part') as MessagePart['id'], text }],
  };
}

function assistantToolCall(
  tool: string,
  args: Record<string, unknown>,
  toolCallId: string,
  sessionId = 'sess_test',
): Message {
  const part: MessagePart = {
    type: 'tool_call',
    id: newId('part') as MessagePart['id'],
    tool,
    toolCallId,
    title: tool,
    args,
    status: 'succeeded',
    output: null,
    changes: [],
    durationMs: 5,
  };
  return {
    id: newId('msg') as Message['id'],
    sessionId: sessionId as Message['sessionId'],
    role: 'assistant',
    createdAt: new Date().toISOString(),
    modelRef: 'codex-cli/model-a' as ModelRef,
    parts: [part],
  };
}

function toolResultMessage(
  tool: string,
  toolCallId: string,
  text: string,
  sessionId = 'sess_test',
): Message {
  const part: MessagePart = {
    type: 'tool_call',
    id: newId('part') as MessagePart['id'],
    tool,
    toolCallId,
    title: tool,
    args: {},
    status: 'succeeded',
    output: {
      text,
      filtered: false,
      originalTokens: null,
      filteredTokens: null,
      recoveryHandle: null,
    },
    changes: [],
    durationMs: 5,
  };
  return {
    id: newId('msg') as Message['id'],
    sessionId: sessionId as Message['sessionId'],
    role: 'assistant',
    createdAt: new Date().toISOString(),
    modelRef: 'codex-cli/model-a' as ModelRef,
    parts: [part],
  };
}

function nativeInput(
  cliModel: ModelInfo,
  messages: readonly Message[],
  overrides: Partial<StepGeneratorInput> = {},
): { input: StepGeneratorInput; deltas: string[] } {
  const deltas: string[] = [];
  const controller = new AbortController();
  const input: StepGeneratorInput = {
    model: cliModel,
    system: 'You are Ferry.',
    messages,
    tools: [],
    signal: controller.signal,
    onDelta: (text) => deltas.push(text),
    modelHints: { toolProtocol: 'native', editFormat: 'search_replace' },
    ...overrides,
  };
  return { input, deltas };
}

function cliModelInfo(h: CoreHarness, kind: CliConnectionKind, ref: ModelRef): ModelInfo {
  const found = getCliBroker(h.services, () => undefined)
    .models(kind)
    .find((entry) => entry.ref === ref);
  if (!found) throw new Error(`missing cli model ${ref}`);
  return found;
}

const builtinProfile = BUILTIN_PROFILES[0];
if (!builtinProfile) throw new Error('Missing built-in profile fixture');
const profile = { ...builtinProfile };
const emitAgent = (): void => undefined;

for (const kind of KINDS) {
  it(`native ${kind}: runs one CLI generation and streams text`, async () => {
    const ref = `${kind}/model-a` as ModelRef;
    const { h, runner } = await setup(() => Promise.resolve(ready(`hello-${kind}`)));
    await enableAndVerify(h, kind, ref);
    const model = cliModelInfo(h, kind, ref);
    const runtime = createSessionDependencies(h.services, emitAgent, undefined, { profile });
    const { input, deltas } = nativeInput(model, [userMessage('hi')]);
    const step = await runtime.gateway.streamStep(input, input.signal);
    expect(step.text).toBe(`hello-${kind}`);
    expect(deltas.join('')).toBe(`hello-${kind}`);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.messages.at(-1)).toMatchObject({ role: 'user', content: 'hi' });
    // The caller's system prompt is preserved verbatim.
    expect(runner.calls[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: 'You are Ferry.',
    });
  });

  it(`gateway ${kind}: explicit CLI model returns a completion over HTTP`, async () => {
    const ref = `${kind}/model-a` as ModelRef;
    const { h } = await setup(() => Promise.resolve(ready(`gw-${kind}`)));
    await enableAndVerify(h, kind, ref);
    const controller = getGatewayController(h.services);
    if (!controller) throw new Error('gateway controller missing');
    await controller.start({ enabled: true, port: 0, allowLan: false });
    const created = controller.createKey(`cli-${kind}`, 'auto-free');
    const token = controller.issueInternalToken(created.key.id);
    try {
      const response = await fetch(`${controller.status.url ?? ''}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'x-ferry-internal-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      expect(body.choices?.[0]?.message?.content).toBe(`gw-${kind}`);
      const record = controller.requests()[0];
      expect(record?.modelRef).toBe(ref);
    } finally {
      await controller.stop();
    }
  });
}

it('native: returns the original caller tool call and continues from its real result', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const tool: AgentTool = {
    name: 'read_file',
    title: 'Read a file',
    schema: z.object({ path: z.string() }),
    execute: () => 'unused',
  };
  const { h, runner } = await setup((request) => {
    const last = request.messages.at(-1);
    if (last?.role === 'tool') return Promise.resolve(ready('finished'));
    return Promise.resolve({
      text: '',
      toolCalls: [{ id: 'call_real_1', name: 'read_file', arguments: { path: 'a.txt' } }],
      usage: { inputTokens: 5, outputTokens: 1, cachedTokens: null, reasoningTokens: null },
      responseModel: 'actual',
    });
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const model = cliModelInfo(h, 'codex-cli', ref);
  const runtime = createSessionDependencies(h.services, emitAgent, undefined, { profile });
  const first = nativeInput(model, [userMessage('read a.txt')], { tools: [tool] });
  const firstStep = await runtime.gateway.streamStep(first.input, first.input.signal);
  expect(firstStep.toolCalls?.[0]).toMatchObject({
    id: 'call_real_1',
    toolCallId: 'call_real_1',
    name: 'read_file',
    input: { path: 'a.txt' },
  });
  expect(firstStep.reportedUsage).toEqual({
    inputTokens: 5,
    outputTokens: 1,
    cachedTokens: null,
    reasoningTokens: null,
  });
  // The caller executes the tool and continues with the real result on the next request.
  const second = nativeInput(
    model,
    [
      userMessage('read a.txt'),
      assistantToolCall('read_file', { path: 'a.txt' }, 'call_real_1'),
      toolResultMessage('read_file', 'call_real_1', 'FILE-CONTENTS'),
    ],
    { tools: [tool] },
  );
  const secondStep = await runtime.gateway.streamStep(second.input, second.input.signal);
  expect(secondStep.text).toBe('finished');
  const continuation = runner.calls[1]?.messages ?? [];
  expect(continuation).toContainEqual({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_real_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      },
    ],
  });
  expect(continuation).toContainEqual({
    role: 'tool',
    content: 'FILE-CONTENTS',
    tool_call_id: 'call_real_1',
  });
});

it('native: profile default beats the connection per-model default', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup((request) =>
    Promise.resolve(ready(`effort:${String(request.options.effort)}`)),
  );
  const service = getCliConnectionService(h.services, () => undefined);
  await service.refresh('codex-cli');
  service.update('codex-cli', {
    surfaces: { native: true },
    defaultOptions: { effort: 'high', speed: 'standard' },
    modelDefaults: { [ref]: { effort: 'low' } },
  });
  expect((await getCliBroker(h.services, () => undefined).verify('codex-cli', ref)).ok).toBe(true);
  const model = cliModelInfo(h, 'codex-cli', ref);
  // A profile default between connection and conversation is applied when no override exists.
  const withProfile = createSessionDependencies(h.services, emitAgent, undefined, {
    profile: { ...profile, cliDefaults: { [ref]: { effort: 'high', speed: 'standard' } } },
  });
  const req = nativeInput(model, [userMessage('hi')]);
  await withProfile.gateway.streamStep(req.input, req.input.signal);
  expect(runner.calls[0]?.options.effort).toBe('high');
});

it('native: rejects an unverified connection before spawning', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(ready('no')));
  const service = getCliConnectionService(h.services, () => undefined);
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { native: true } });
  const model = cliModelInfo(h, 'codex-cli', ref);
  const runtime = createSessionDependencies(h.services, emitAgent, undefined, { profile });
  const { input } = nativeInput(model, [userMessage('hi')]);
  await expect(runtime.gateway.streamStep(input, input.signal)).rejects.toThrow(/not verified/);
  expect(runner.calls).toHaveLength(0);
});

it('native: rejects a surface that is not opted in', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(ready('no')));
  await enableAndVerify(h, 'codex-cli', ref);
  getCliConnectionService(h.services, () => undefined).update('codex-cli', {
    surfaces: { native: false },
  });
  const model = cliModelInfo(h, 'codex-cli', ref);
  const runtime = createSessionDependencies(h.services, emitAgent, undefined, { profile });
  const { input } = nativeInput(model, [userMessage('hi')]);
  await expect(runtime.gateway.streamStep(input, input.signal)).rejects.toThrow(/not opted in/);
  expect(runner.calls).toHaveLength(0);
});

it('normalizes OpenCode ACP categories into transport kinds preserving reset metadata', async () => {
  const ref = 'opencode-cli/model-a' as ModelRef;
  const { h } = await setup(() =>
    Promise.reject(
      new OpenCodeAcpError('{"quota":"exhausted"}', {
        category: 'provider',
        statusCode: 429,
        resetAt: '2026-01-02T00:00:00.000Z',
      }),
    ),
  );
  await enableAndVerify(h, 'opencode-cli', ref);
  const broker = getCliBroker(h.services, () => undefined);
  const resolved = broker.model(ref);
  if (!resolved) throw new Error('missing');
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: ref,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    kind: 'exhausted_capacity',
    statusCode: 429,
    resetAt: '2026-01-02T00:00:00.000Z',
  });
});

it('maps a native abort to a cancellation, not a provider error', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h } = await setup(() =>
    Promise.reject(Object.assign(new Error('native abort'), { name: 'NativeAbortError' })),
  );
  await enableAndVerify(h, 'codex-cli', ref);
  const broker = getCliBroker(h.services, () => undefined);
  await expect(
    broker.dispatch({
      surface: 'native',
      modelRef: ref,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});

it('rejects an already-expired deadline before claiming a free slot', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(ready('x')));
  await enableAndVerify(h, 'codex-cli', ref);
  const broker = getCliBroker(h.services, () => undefined);
  const resolved = broker.model(ref);
  if (!resolved) throw new Error('missing');
  await expect(
    broker.run({
      connection: resolved.connection,
      model: resolved.model,
      options: { effort: null, speed: 'standard' },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 0,
    }),
  ).rejects.toThrow(/deadline/);
  expect(runner.calls).toHaveLength(0);
});

it('reduces the transport timeout to the remaining budget after a queue wait', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    const ref = 'codex-cli/model-a' as ModelRef;
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const { h } = await setup(() => Promise.resolve(ready('warm')));
    await enableAndVerify(h, 'codex-cli', ref);
    const resolved = getCliBroker(h.services, () => undefined).model(ref);
    if (!resolved) throw new Error('missing');
    const seen: (number | undefined)[] = [];
    const gated: CliTurnRunner = async (request) => {
      seen.push(request.timeoutMs);
      if (seen.length === 1) await activeGate;
      return ready('done');
    };
    const broker = new CliBroker(
      h.services,
      getCliConnectionService(h.services, () => undefined),
      {
        runTurn: gated,
      },
    );
    const base = {
      connection: resolved.connection,
      model: resolved.model,
      options: { effort: null, speed: 'standard' as const },
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [],
    };
    const first = broker.run({ ...base, signal: new AbortController().signal, timeoutMs: 1000 });
    const second = broker.run({ ...base, signal: new AbortController().signal, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(400);
    releaseActive();
    await first;
    await second;
    const secondTimeout = seen[1];
    expect(secondTimeout).toBeDefined();
    expect(secondTimeout ?? 0).toBeGreaterThan(0);
    expect(secondTimeout ?? 0).toBeLessThanOrEqual(600);
  } finally {
    vi.useRealTimers();
  }
});

it('gateway: a CLI tool call is returned to the caller and continues from its real result', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup((request) => {
    const last = request.messages.at(-1);
    if (last?.role === 'tool') return Promise.resolve(ready('continued'));
    return Promise.resolve({
      text: '',
      toolCalls: [{ id: 'call_gw_1', name: 'read_file', arguments: { path: 'x' } }],
      usage: { inputTokens: 3, outputTokens: 1, cachedTokens: null, reasoningTokens: null },
      responseModel: 'actual',
    });
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey('cli-tools', 'auto-free');
  const token = controller.issueInternalToken(created.key.id);
  const url = `${controller.status.url ?? ''}/v1/chat/completions`;
  const headers = { 'x-ferry-internal-token': token, 'content-type': 'application/json' };
  try {
    const first = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ref,
        tools: [
          { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
        ],
        messages: [{ role: 'user', content: 'read x' }],
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      choices?: { message?: { tool_calls?: { id: string; function: { name: string } }[] } }[];
    };
    expect(firstBody.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe('call_gw_1');
    const second = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ref,
        tools: [
          { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
        ],
        messages: [
          { role: 'user', content: 'read x' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_gw_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"x"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_gw_1', content: 'REAL-RESULT' },
        ],
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { choices?: { message?: { content?: string } }[] };
    expect(secondBody.choices?.[0]?.message?.content).toBe('continued');
    const continuation = runner.calls[1]?.messages ?? [];
    expect(continuation).toContainEqual({
      role: 'tool',
      content: 'REAL-RESULT',
      tool_call_id: 'call_gw_1',
    });
  } finally {
    await controller.stop();
  }
});

it('gateway: rejects unsupported structured output and images before spawning', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(ready('x')));
  await enableAndVerify(h, 'codex-cli', ref);
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey('cli-reject', 'auto-free');
  const token = controller.issueInternalToken(created.key.id);
  const url = `${controller.status.url ?? ''}/v1/chat/completions`;
  const headers = { 'x-ferry-internal-token': token, 'content-type': 'application/json' };
  try {
    const structured = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ref,
        messages: [{ role: 'user', content: 'hi' }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'x', schema: { type: 'object' } },
        },
      }),
    });
    expect(structured.status).toBe(400);
    const image = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ref,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'image_url', image_url: { url: 'x' } },
            ],
          },
        ],
      }),
    });
    expect(image.status).toBe(400);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await controller.stop();
  }
});

it('gateway: rejects an unverified CLI model with an actionable message', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(ready('x')));
  const service = getCliConnectionService(h.services, () => undefined);
  await service.refresh('codex-cli');
  service.update('codex-cli', { surfaces: { gateway: true } });
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey('cli-unverified', 'auto-free');
  const token = controller.issueInternalToken(created.key.id);
  try {
    const response = await fetch(`${controller.status.url ?? ''}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-ferry-internal-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toMatch(/not verified/i);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await controller.stop();
  }
});

it('admission refuses metered/unknown billing without spending authorization; included passes', () => {
  const verified = {
    ...connection('codex-cli', []),
    surfaces: { native: true, gateway: true },
    verify: {
      state: 'verified' as const,
      modelRef: 'codex-cli/m' as ModelRef,
      checkedAt: new Date().toISOString(),
      message: null,
    },
  };
  const metered = model('codex-cli', 'm', { billing: 'metered' });
  const unknown = model('codex-cli', 'm', { billing: 'unknown' });
  const included = model('codex-cli', 'm', { billing: 'included_subscription' });
  expect(cliManualAdmission(verified, metered, 'native').statusCode).toBe(402);
  expect(cliManualAdmission(verified, unknown, 'native').statusCode).toBe(402);
  expect(cliManualAdmission(verified, metered, 'native', { authorizeSpend: () => true }).ok).toBe(
    true,
  );
  expect(cliManualAdmission(verified, included, 'native').ok).toBe(true);
  // A hidden or unverified model never dispatches even when included.
  const unverified = {
    ...verified,
    verify: { state: 'unverified' as const, modelRef: null, checkedAt: null, message: null },
  };
  expect(cliManualAdmission(unverified, included, 'native').statusCode).toBe(400);
});

it('gateway: still serves a standard API model (regression)', async () => {
  const { h } = await setup(() => Promise.resolve(ready('unused-cli')));
  const provider = 'openrouter';
  const apiModel = h.services.models
    .list(provider)
    .find((entry) => entry.toolCalling && entry.free);
  if (!apiModel) throw new Error('no api model');
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey('api-regression', 'auto-free');
  const token = controller.issueInternalToken(created.key.id);
  try {
    const response = await fetch(`${controller.status.url ?? ''}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-ferry-internal-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: apiModel.ref, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content).toBe('Hello.');
  } finally {
    await controller.stop();
  }
});

it('native: rejects a pre-aborted signal before any dispatch', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(ready('x')));
  await enableAndVerify(h, 'codex-cli', ref);
  const model = cliModelInfo(h, 'codex-cli', ref);
  const runtime = createSessionDependencies(h.services, emitAgent, undefined, { profile });
  const controller = new AbortController();
  controller.abort(new Error('cancelled by user'));
  const { input } = nativeInput(model, [userMessage('hi')], { signal: controller.signal });
  await expect(runtime.gateway.streamStep(input, controller.signal)).rejects.toThrow();
  expect(runner.calls).toHaveLength(0);
});

it('preserves reported cache and reasoning dimensions including zero', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h } = await setup(() =>
    Promise.resolve(
      ready('x', { inputTokens: 10, outputTokens: 4, cachedTokens: 0, reasoningTokens: 7 }),
    ),
  );
  await enableAndVerify(h, 'codex-cli', ref);
  const model = cliModelInfo(h, 'codex-cli', ref);
  const runtime = createSessionDependencies(h.services, emitAgent, undefined, { profile });
  const { input } = nativeInput(model, [userMessage('hi')]);
  const step = await runtime.gateway.streamStep(input, input.signal);
  expect(step.reportedUsage).toEqual({
    inputTokens: 10,
    outputTokens: 4,
    cachedTokens: 0,
    reasoningTokens: 7,
  });
});

it('migrates the legacy Zen CLI opt-in once and preserves an explicit shared record', () => {
  const store = new Map<string, unknown>();
  const settings = {
    get: (key: string) => store.get(key),
    put: (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as import('@ferry/storage').SettingsRepository;
  store.set('global', {
    ...sampleSettings,
    zenCliMigratedToShared: false,
    opencodeZenTransport: 'cli',
    opencodeZenCliUseFerryKey: true,
    cliConnections: {},
  });
  migrateLegacyZenCliConnection(settings);
  const after = store.get('global') as {
    zenCliMigratedToShared: boolean;
    cliConnections: Record<string, { native: boolean; gateway: boolean; credentialMode: string }>;
  };
  expect(after.zenCliMigratedToShared).toBe(true);
  expect(after.cliConnections['opencode-cli']).toMatchObject({
    native: true,
    gateway: true,
    credentialMode: 'ferry',
  });
  // An explicit shared false afterwards is never overwritten and the migration does not run again.
  const explicit = {
    ...sampleSettings,
    zenCliMigratedToShared: true,
    opencodeZenTransport: 'cli',
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
  };
  store.set('global', explicit);
  migrateLegacyZenCliConnection(settings);
  expect((store.get('global') as typeof explicit).cliConnections['opencode-cli'].native).toBe(
    false,
  );
});

it('does not treat a reported zero as an unreported dimension', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h } = await setup(() => Promise.resolve(ready('x', { inputTokens: 0, outputTokens: 0 })));
  await enableAndVerify(h, 'codex-cli', ref);
  const model = cliModelInfo(h, 'codex-cli', ref);
  const runtime = createSessionDependencies(h.services, emitAgent, undefined, { profile });
  const { input } = nativeInput(model, [userMessage('hi')]);
  const step: GeneratedStep = await runtime.gateway.streamStep(input, input.signal);
  expect(step.reportedUsage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    reasoningTokens: null,
  });
});
