import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BUILTIN_PROFILES } from '@ferry/router';
import { sampleSettings } from '@ferry/shared/testing';
import {
  ModelInfoSchema,
  type CliConnection,
  type CliConnectionKind,
  type CliModelCapabilities,
  type ModelRef,
  type Profile,
} from '@ferry/shared';
import { CliTransportError, deriveCliAccountKey, type CliTurnResult } from '@ferry/delegate';
import { getCliBroker, type CliTurnRunner } from '../src/cli-broker.js';
import { getCliConnectionService } from '../src/cli-connections.js';
import { getGatewayController } from '../src/gateway.js';
import { startHarness, type CoreHarness } from './qa-w3-harness.js';

vi.setConfig({ testTimeout: 30_000 });

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

async function setup(
  runnerImpl: CliTurnRunner,
  modelsByKind: Partial<Record<CliConnectionKind, CliModelCapabilities[]>> = {},
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ h: CoreHarness; runner: { calls: Parameters<CliTurnRunner>[0][] } }> {
  const kinds: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];
  const fixtures = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      connection(kind, modelsByKind[kind] ?? [cliModel(kind, 'model-a')]),
    ]),
  ) as Record<CliConnectionKind, CliConnection>;
  const runner = { calls: [] as Parameters<CliTurnRunner>[0][] };
  const cliRunTurn: CliTurnRunner = async (request) => {
    if (
      request.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('Reply with exactly Ready'),
      )
    ) {
      request.onText?.('Ready');
      return {
        text: 'Ready',
        toolCalls: [],
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
        responseModel: 'actual',
      };
    }
    runner.calls.push(request);
    return runnerImpl(request);
  };
  harness = await startHarness({
    cliScan: (kind) => Promise.resolve(fixtures[kind]),
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn,
    ...(options.env ? { env: options.env } : {}),
  });
  harness.services.settings.put('global', sampleSettings);
  return { h: harness, runner };
}

function cliProfile(overrides: Partial<Profile> = {}): Profile {
  const base = BUILTIN_PROFILES[0];
  if (!base) throw new Error('Missing built-in profile fixture');
  return {
    ...base,
    id: 'profile_cli_auto' as Profile['id'],
    name: 'CLI Auto',
    allowSubscriptionCli: true,
    allowedProviders: 'all',
    ...overrides,
  };
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

function disableApi(h: CoreHarness): void {
  const saved = h.services.providers.get('openrouter');
  if (saved) h.services.providers.put({ ...saved, enabled: false });
}

async function startGateway(h: CoreHarness, profileId: string) {
  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey('cli-auto', profileId);
  const token = controller.issueInternalToken(created.key.id);
  return {
    controller,
    created,
    token,
    url: `${controller.status.url ?? ''}/v1/chat/completions`,
    headers: { 'x-ferry-internal-token': token, 'content-type': 'application/json' },
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

it('Auto serves an eligible free CLI route and records producer + nullable usage', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() =>
    Promise.resolve(answer('cli-auto', { inputTokens: 0, outputTokens: null })),
  );
  await enableAndVerify(h, 'codex-cli', ref);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content).toBe('cli-auto');
    expect(runner.calls).toHaveLength(1);
    const record = gw.controller.requests()[0];
    expect(record?.reportedUsage).toEqual({
      inputTokens: 0,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    });
    expect(record?.usageReported).toBe(true);
    expect(record?.servedConnectionId).toBe('codex-cli');
    expect(record?.servedProviderId).toBe('codex-cli');
    expect(record?.servedAccountKey).toBe(`codex-cli:${'a'.repeat(24)}`);
  } finally {
    await gw.controller.stop();
  }
});

it('Auto includes an Included CLI route only when the profile opts in', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('included')));
  await enableAndVerify(h, 'codex-cli', ref);
  disableApi(h);
  const optedOut = cliProfile({
    id: 'profile_cli_off' as Profile['id'],
    allowSubscriptionCli: false,
  });
  h.services.settings.put('profiles', [optedOut, cliProfile()]);
  const gw = await startGateway(h, String(optedOut.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(400);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await gw.controller.stop();
  }

  const gw2 = await startGateway(h, 'profile_cli_auto');
  try {
    const response = await fetch(gw2.url, {
      method: 'POST',
      headers: gw2.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(runner.calls).toHaveLength(1);
  } finally {
    await gw2.controller.stop();
  }
});

it('Auto prefers a free CLI route before a higher-quality Included route', async () => {
  const free = 'codex-cli/free-model' as ModelRef;
  const included = 'codex-cli/included-model' as ModelRef;
  const { h, runner } = await setup(
    (request) => Promise.resolve(answer(`served:${request.model.ref}`)),
    {
      'codex-cli': [
        cliModel('codex-cli', 'included-model', { billing: 'included_subscription' }),
        cliModel('codex-cli', 'free-model', { billing: 'free' }),
      ],
    },
  );
  await enableAndVerify(h, 'codex-cli', free);
  await enableAndVerify(h, 'codex-cli', included);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(runner.calls[0]?.model.ref).toBe(free);
  } finally {
    await gw.controller.stop();
  }
});

it('Auto suppresses a second model in the same exhausted bucket without running it', async () => {
  const a = 'codex-cli/model-a' as ModelRef;
  const b = 'codex-cli/model-b' as ModelRef;
  const { h, runner } = await setup(
    () => Promise.reject(new CliTransportError('exhausted_capacity', 'quota exhausted')),
    {
      'codex-cli': [
        cliModel('codex-cli', 'model-a', { billing: 'free' }),
        cliModel('codex-cli', 'model-b', { billing: 'free' }),
      ],
    },
  );
  await enableAndVerify(h, 'codex-cli', a);
  await enableAndVerify(h, 'codex-cli', b);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(429);
    // The same-bucket sibling never reaches the runner: the broker guard blocks it pre-generation.
    expect(runner.calls).toHaveLength(1);
  } finally {
    await gw.controller.stop();
  }
});

it('Auto falls back to an eligible different account after an exhausted bucket', async () => {
  const codexRef = 'codex-cli/model-a' as ModelRef;
  const opencodeRef = 'opencode-cli/model-a' as ModelRef;
  const { h, runner } = await setup(
    (request) => {
      if (request.connection.kind === 'codex-cli')
        return Promise.reject(new CliTransportError('exhausted_capacity', 'quota exhausted'));
      return Promise.resolve(answer('opencode-served'));
    },
    {
      'codex-cli': [cliModel('codex-cli', 'model-a', { billing: 'free' })],
      'opencode-cli': [cliModel('opencode-cli', 'model-a', { billing: 'included_subscription' })],
    },
  );
  await enableAndVerify(h, 'codex-cli', codexRef);
  await enableAndVerify(h, 'opencode-cli', opencodeRef);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content).toBe('opencode-served');
    expect(gw.controller.requests()[0]?.servedConnectionId).toBe('opencode-cli');
    expect(runner.calls.map((call) => call.connection.kind)).toEqual(['codex-cli', 'opencode-cli']);
  } finally {
    await gw.controller.stop();
  }
});

it('Auto preserves profile effort defaults when only service_tier is specified', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup((request) =>
    Promise.resolve(answer(`effort:${String(request.options.effort)}`)),
  );
  await enableAndVerify(h, 'codex-cli', ref);
  disableApi(h);
  const profile = cliProfile({ cliDefaults: { [ref]: { effort: 'high', speed: 'standard' } } });
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({
        model: 'ferry/auto',
        service_tier: 'default',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(200);
    expect(runner.calls[0]?.options.effort).toBe('high');
    expect(runner.calls[0]?.options.speed).toBe('standard');
  } finally {
    await gw.controller.stop();
  }
});

it('does not splice another model after partial CLI output; emits a typed error', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup((request) => {
    request.onText?.('partial answer');
    return Promise.reject(new CliTransportError('provider_error', 'upstream failed mid-stream'));
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({
        model: 'ferry/auto',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await response.text();
    expect(text).toContain('partial answer');
    expect(text).toContain('error');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(runner.calls).toHaveLength(1);
  } finally {
    await gw.controller.stop();
  }
});

it('excludes CLI routes when the gateway surface is opted out', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('x')));
  await enableAndVerify(h, 'codex-cli', ref);
  getCliConnectionService(h.services, () => undefined).update('codex-cli', {
    surfaces: { native: true, gateway: false },
  });
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(400);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await gw.controller.stop();
  }
});

it('honors the key concrete allowlist for CLI Auto routes', async () => {
  const allowed = 'codex-cli/free-model' as ModelRef;
  const denied = 'codex-cli/other-model' as ModelRef;
  const { h, runner } = await setup(
    (request) => Promise.resolve(answer(`served:${request.model.ref}`)),
    {
      'codex-cli': [
        cliModel('codex-cli', 'free-model', { billing: 'free' }),
        cliModel('codex-cli', 'other-model', { billing: 'free' }),
      ],
    },
  );
  await enableAndVerify(h, 'codex-cli', allowed);
  await enableAndVerify(h, 'codex-cli', denied);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  gw.controller.updateKey(gw.created.key.id, { allowedModels: [allowed] });
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(runner.calls[0]?.model.ref).toBe(allowed);
  } finally {
    await gw.controller.stop();
  }
});

it('rejects an advertised-but-unrunnable native effort before generation', async () => {
  const ref = 'codex-cli/ultra-model' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('x')), {
    'codex-cli': [
      cliModel('codex-cli', 'ultra-model', { billing: 'free', efforts: ['low', 'ultra'] }),
    ],
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({
        model: 'ferry/auto',
        reasoning_effort: 'ultra',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(400);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await gw.controller.stop();
  }
});

it('honors a runnable advertised native effort token through the CLI route', async () => {
  const ref = 'codex-cli/native-effort' as ModelRef;
  const { h, runner } = await setup(
    (request) => Promise.resolve(answer(`effort:${String(request.options.effort)}`)),
    {
      'codex-cli': [
        cliModel('codex-cli', 'native-effort', {
          billing: 'free',
          efforts: ['low', 'none'],
          defaultEffort: 'low',
        }),
      ],
    },
  );
  await enableAndVerify(h, 'codex-cli', ref);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    // `none` is a native token outside the standard-API enum; it must reach the CLI, not be dropped.
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({
        model: 'ferry/auto',
        reasoning_effort: 'none',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content).toBe('effort:none');
    expect(runner.calls[0]?.options.effort).toBe('none');
  } finally {
    await gw.controller.stop();
  }
});

it('records exact reported cache and reasoning dimensions including zero', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h } = await setup(() =>
    Promise.resolve(
      answer('x', { inputTokens: 10, outputTokens: 4, cachedTokens: 0, reasoningTokens: 7 }),
    ),
  );
  await enableAndVerify(h, 'codex-cli', ref);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(gw.controller.requests()[0]?.reportedUsage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: 0,
      reasoningTokens: 7,
    });
  } finally {
    await gw.controller.stop();
  }
});

it('Auto never fabricates an unreported reasoning dimension', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h } = await setup(() =>
    Promise.resolve(answer('x', { inputTokens: 3, outputTokens: 2 })),
  );
  await enableAndVerify(h, 'codex-cli', ref);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(gw.controller.requests()[0]?.reportedUsage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      cachedTokens: null,
      reasoningTokens: null,
    });
  } finally {
    await gw.controller.stop();
  }
});

const CLI_KINDS: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];

it.each(CLI_KINDS)(
  'Auto serves a free %s CLI route through the broker with no API duplicate',
  async (kind) => {
    const ref = `${kind}/model-a` as ModelRef;
    const { h, runner } = await setup(() => Promise.resolve(answer(`served-${kind}`)), {
      [kind]: [cliModel(kind, 'model-a', { billing: 'free' })],
    });
    await enableAndVerify(h, kind, ref);
    const profile = cliProfile();
    h.services.settings.put('profiles', [profile]);
    disableApi(h);
    const gw = await startGateway(h, String(profile.id));
    try {
      const response = await fetch(gw.url, {
        method: 'POST',
        headers: gw.headers,
        body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      expect(body.choices?.[0]?.message?.content).toBe(`served-${kind}`);
      expect(runner.calls).toHaveLength(1);
      // A CLI route must never be sent through an API adapter as a duplicate.
      expect(h.server.requests).toHaveLength(0);
      expect(gw.controller.requests()[0]?.servedConnectionId).toBe(kind);
    } finally {
      await gw.controller.stop();
    }
  },
);

it.each(CLI_KINDS)(
  'Auto replays a caller tool call and result through the %s CLI route',
  async (kind) => {
    const ref = `${kind}/model-a` as ModelRef;
    const { h, runner } = await setup(
      (request) => {
        const last = request.messages.at(-1);
        if (last?.role === 'tool' && last.content === 'REAL-RESULT')
          return Promise.resolve(answer('finished'));
        return Promise.resolve({
          text: '',
          toolCalls: [{ id: 'call_gw', name: 'lookup', arguments: { q: 'x' } }],
          usage: { inputTokens: 2, outputTokens: 1, cachedTokens: null, reasoningTokens: null },
          responseModel: 'actual',
        });
      },
      { [kind]: [cliModel(kind, 'model-a', { billing: 'free' })] },
    );
    await enableAndVerify(h, kind, ref);
    const profile = cliProfile();
    h.services.settings.put('profiles', [profile]);
    disableApi(h);
    const gw = await startGateway(h, String(profile.id));
    const tool = [
      { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
    ];
    try {
      const first = await fetch(gw.url, {
        method: 'POST',
        headers: gw.headers,
        body: JSON.stringify({
          model: 'ferry/auto',
          tools: tool,
          messages: [{ role: 'user', content: 'look it up' }],
        }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        choices?: { message?: { tool_calls?: { id: string; function: { name: string } }[] } }[];
      };
      expect(firstBody.choices?.[0]?.message?.tool_calls?.[0]?.id).toBe('call_gw');
      const second = await fetch(gw.url, {
        method: 'POST',
        headers: gw.headers,
        body: JSON.stringify({
          model: 'ferry/auto',
          tools: tool,
          messages: [
            { role: 'user', content: 'look it up' },
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_gw',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"x"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_gw', content: 'REAL-RESULT' },
          ],
        }),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      expect(secondBody.choices?.[0]?.message?.content).toBe('finished');
      const continuation = runner.calls[1]?.messages ?? [];
      expect(continuation).toContainEqual({
        role: 'tool',
        content: 'REAL-RESULT',
        tool_call_id: 'call_gw',
      });
    } finally {
      await gw.controller.stop();
    }
  },
);

it('native-only opt-in does not expose a Gateway Auto CLI route; gateway-only does', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('served')), {
    'codex-cli': [cliModel('codex-cli', 'model-a', { billing: 'free' })],
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const service = getCliConnectionService(h.services, () => undefined);
  service.update('codex-cli', { surfaces: { native: true, gateway: false } });
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const blocked = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(blocked.status).toBe(400);
    expect(runner.calls).toHaveLength(0);

    service.update('codex-cli', { surfaces: { native: false, gateway: true } });
    const served = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(served.status).toBe(200);
    expect(runner.calls).toHaveLength(1);
  } finally {
    await gw.controller.stop();
  }
});

it('a key profile opt-out is not loosened by a request profile opt-in', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('included')));
  await enableAndVerify(h, 'codex-cli', ref);
  disableApi(h);
  const optedOut = cliProfile({
    id: 'profile_cli_off' as Profile['id'],
    allowSubscriptionCli: false,
  });
  const optedIn = cliProfile({
    id: 'profile_cli_on' as Profile['id'],
    allowSubscriptionCli: true,
  });
  h.services.settings.put('profiles', [optedOut, optedIn]);
  const gw = await startGateway(h, String(optedOut.id));
  try {
    // The key's assigned profile is the ceiling; a request cannot opt the key in.
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({
        model: 'ferry/profile_cli_on',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(400);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await gw.controller.stop();
  }
});

it('prefers a free standard-API route before an Included CLI route', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('included')));
  await enableAndVerify(h, 'codex-cli', ref);
  // Keep the seeded free API provider enabled; the Included CLI must not jump ahead of it.
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(runner.calls).toHaveLength(0);
    expect(h.server.requests.length).toBeGreaterThan(0);
  } finally {
    await gw.controller.stop();
  }
});

it('serves an Included-only Auto route when the profile opts in', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('included-only')));
  await enableAndVerify(h, 'codex-cli', ref);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(runner.calls).toHaveLength(1);
    expect(gw.controller.requests()[0]?.servedConnectionId).toBe('codex-cli');
  } finally {
    await gw.controller.stop();
  }
});

it('prefers a free CLI route before a separately authorized paid API backup', async () => {
  const ref = 'codex-cli/model-a' as ModelRef;
  const { h, runner } = await setup(() => Promise.resolve(answer('cli-free')), {
    'codex-cli': [cliModel('codex-cli', 'model-a', { billing: 'free' })],
  });
  await enableAndVerify(h, 'codex-cli', ref);
  const template = h.services.models.list('openrouter').find((model) => model.toolCalling);
  if (!template) throw new Error('missing api template');
  h.services.models.replace('openrouter', [
    ModelInfoSchema.parse({
      ...template,
      ref: 'openrouter/paid-auto',
      free: false,
      priceInPerM: 1000,
      priceOutPerM: 1000,
    }),
  ]);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  const gw = await startGateway(h, String(profile.id));
  gw.controller.updateKey(gw.created.key.id, { paidBackup: true, budgetUsd: 1 });
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(runner.calls).toHaveLength(1);
    expect(h.server.requests).toHaveLength(0);
    expect(gw.controller.requests()[0]?.servedConnectionId).toBe('codex-cli');
  } finally {
    await gw.controller.stop();
  }
});

it('retries a temporary CLI failure once, then stops after partial output without splicing', async () => {
  const codexRef = 'codex-cli/model-a' as ModelRef;
  const opencodeRef = 'opencode-cli/model-a' as ModelRef;
  let attempt = 0;
  const { h, runner } = await setup(
    (request) => {
      if (request.connection.kind === 'opencode-cli') return Promise.resolve(answer('other'));
      attempt += 1;
      if (attempt === 1)
        return Promise.reject(
          new CliTransportError('temporary_rate_limit', 'busy', { retryAfterMs: 200 }),
        );
      request.onText?.('partial retry');
      return Promise.reject(new CliTransportError('provider_error', 'failed after partial'));
    },
    {
      'codex-cli': [cliModel('codex-cli', 'model-a', { billing: 'free' })],
      'opencode-cli': [cliModel('opencode-cli', 'model-a', { billing: 'included_subscription' })],
    },
  );
  await enableAndVerify(h, 'codex-cli', codexRef);
  await enableAndVerify(h, 'opencode-cli', opencodeRef);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({
        model: 'ferry/auto',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await response.text();
    expect(text).toContain('partial retry');
    expect(text).toContain('error');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(runner.calls.map((call) => call.connection.kind)).toEqual(['codex-cli', 'codex-cli']);
    expect(attempt).toBe(2);
  } finally {
    await gw.controller.stop();
  }
});

it('does not wait out a temporary retry that exceeds the policy; falls back instead', async () => {
  const codexRef = 'codex-cli/model-a' as ModelRef;
  const opencodeRef = 'opencode-cli/model-a' as ModelRef;
  const { h, runner } = await setup(
    (request) => {
      if (request.connection.kind === 'codex-cli')
        return Promise.reject(
          new CliTransportError('temporary_rate_limit', 'busy', { retryAfterMs: 60_000 }),
        );
      return Promise.resolve(answer('opencode-served'));
    },
    {
      'codex-cli': [cliModel('codex-cli', 'model-a', { billing: 'free' })],
      'opencode-cli': [cliModel('opencode-cli', 'model-a', { billing: 'included_subscription' })],
    },
  );
  await enableAndVerify(h, 'codex-cli', codexRef);
  await enableAndVerify(h, 'opencode-cli', opencodeRef);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  try {
    const response = await fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content).toBe('opencode-served');
    expect(runner.calls.map((call) => call.connection.kind)).toEqual(['codex-cli', 'opencode-cli']);
  } finally {
    await gw.controller.stop();
  }
});

it('cancels an inline temporary wait promptly without falling back or retrying', async () => {
  const codexRef = 'codex-cli/model-a' as ModelRef;
  const opencodeRef = 'opencode-cli/model-a' as ModelRef;
  const { h, runner } = await setup(
    (request) => {
      if (request.connection.kind === 'codex-cli')
        return Promise.reject(
          new CliTransportError('temporary_rate_limit', 'busy', { retryAfterMs: 1500 }),
        );
      return Promise.resolve(answer('other'));
    },
    {
      'codex-cli': [cliModel('codex-cli', 'model-a', { billing: 'free' })],
      'opencode-cli': [cliModel('opencode-cli', 'model-a', { billing: 'included_subscription' })],
    },
  );
  await enableAndVerify(h, 'codex-cli', codexRef);
  await enableAndVerify(h, 'opencode-cli', opencodeRef);
  const profile = cliProfile();
  h.services.settings.put('profiles', [profile]);
  disableApi(h);
  const gw = await startGateway(h, String(profile.id));
  const controller = new AbortController();
  try {
    const pending = fetch(gw.url, {
      method: 'POST',
      headers: gw.headers,
      body: JSON.stringify({ model: 'ferry/auto', messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(
      () => {
        expect(runner.calls).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    controller.abort();
    await rejected;
    // The wait woke on cancellation: no retry ran and no other-account fallback was attempted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.calls.map((call) => call.connection.kind)).toEqual(['codex-cli']);
  } finally {
    await gw.controller.stop();
  }
});

it('attributes a Gateway CLI route to the opencode-cli provider with the upstream captured separately', async () => {
  const ref = 'opencode-cli/opencode-go/model-a' as ModelRef;
  const xdg = await mkdtemp(join(tmpdir(), 'ferry-gw-opencode-'));
  await mkdir(join(xdg, 'opencode'), { recursive: true });
  await writeFile(
    join(xdg, 'opencode', 'auth.json'),
    JSON.stringify({ 'opencode-go': { type: 'api', key: 'fake-go-key' } }),
    'utf8',
  );
  try {
    const { h } = await setup(
      () => Promise.resolve(answer('go-served')),
      {
        'opencode-cli': [
          cliModel('opencode-cli', 'opencode-go/model-a', {
            upstreamProvider: 'opencode-go',
            billing: 'included_subscription',
          }),
        ],
      },
      { env: { XDG_DATA_HOME: xdg } },
    );
    await enableAndVerify(h, 'opencode-cli', ref);
    const profile = cliProfile();
    h.services.settings.put('profiles', [profile]);
    disableApi(h);
    const gw = await startGateway(h, String(profile.id));
    try {
      const response = await fetch(gw.url, {
        method: 'POST',
        headers: gw.headers,
        body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      expect(body.choices?.[0]?.message?.content).toBe('go-served');
      const expectedAccountKey = deriveCliAccountKey(
        'opencode-cli',
        'opencode-go\u0000fake-go-key',
      );
      // Ferry routing identity is the CLI connection, never the credential-source upstream provider.
      expect(response.headers.get('x-ferry-served-provider')).toBe('opencode-cli');
      expect(response.headers.get('x-ferry-served-connection')).toBe('opencode-cli');
      expect(response.headers.get('x-ferry-served-account')).toBe(expectedAccountKey);
      expect(response.headers.get('x-ferry-usage-reported')).toBe('false');
      const record = gw.controller.requests()[0];
      expect(record?.modelRef).toBe(ref);
      expect(record?.servedModel).toBe(ref);
      expect(record?.providerId).toBe('opencode-cli');
      expect(record?.servedProviderId).toBe('opencode-cli');
      expect(record?.servedConnectionId).toBe('opencode-cli');
      expect(record?.servedAccountKey).toBe(expectedAccountKey);
      expect(record?.reportedUsage).toEqual({
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
      });
      expect(record?.usageReported).toBe(false);
      expect(record?.attempts?.find((attempt) => attempt.status === 'served')).toMatchObject({
        providerId: 'opencode-cli',
        connectionId: 'opencode-cli',
        accountKey: expectedAccountKey,
      });
      // The native route never claims the standard Go/Zen API provider id or its quota bucket.
      expect(record?.providerId).not.toBe('opencode-go');
      expect(record?.providerId).not.toBe('opencode');
    } finally {
      await gw.controller.stop();
    }
  } finally {
    await rm(xdg, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
