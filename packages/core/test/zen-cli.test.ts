import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ModelRefSchema,
  ProviderIdSchema,
  type CliConnection,
  type CliConnectionKind,
} from '@ferry/shared';
import type { CliTurnResult } from '@ferry/delegate';
import { zenConversation } from '../src/zen-cli.js';
import { getCliBroker, type CliBrokerRequest, type CliTurnRunner } from '../src/cli-broker.js';
import { getCliConnectionService } from '../src/cli-connections.js';
import { getGatewayController } from '../src/gateway.js';
import { startHarness, type CoreHarness } from './qa-w3-harness.js';
vi.setConfig({ testTimeout: 30_000 });

const CANONICAL = ModelRefSchema.parse('opencode-cli/opencode/big-pickle');
const OPENCODE = ProviderIdSchema.parse('opencode');

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

function openCodeConnection(): CliConnection {
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
      {
        ref: CANONICAL,
        connectionId: 'opencode-cli',
        providerId: 'opencode-cli',
        upstreamId: 'opencode/big-pickle',
        upstreamProvider: 'opencode',
        name: 'Big Pickle',
        efforts: ['low', 'high'],
        defaultEffort: null,
        speeds: ['standard'],
        defaultSpeed: 'standard',
        modalities: ['text'],
        toolCalling: true,
        contextWindow: 200_000,
        maxOutput: 8_192,
        billing: 'free',
        hidden: false,
      },
    ],
    usage: emptyUsage('opencode-cli'),
    lastChecked: null,
    discoveryMessage: null,
  };
}

const isVerify = (request: CliBrokerRequest): boolean =>
  request.messages.some(
    (message) =>
      typeof message.content === 'string' && message.content.includes('Reply with exactly Ready'),
  );

function ready(text: string, request: CliBrokerRequest): CliTurnResult {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 12, outputTokens: 2, cachedTokens: null, reasoningTokens: null },
    responseModel: request.model.upstreamId,
  };
}

async function setup(runner: CliTurnRunner): Promise<{
  h: CoreHarness;
  service: ReturnType<typeof getCliConnectionService>;
}> {
  harness = await startHarness({
    cliScan: (kind) =>
      Promise.resolve(
        kind === 'opencode-cli'
          ? openCodeConnection()
          : { ...openCodeConnection(), id: kind, kind, providerId: kind, models: [] },
      ),
    cliUsage: (kind) => Promise.resolve({ usage: emptyUsage(kind), account: null }),
    cliRunTurn: runner,
  });
  const service = getCliConnectionService(harness.services, () => undefined);
  return { h: harness, service };
}

it('verifies a free Zen model through the shared broker and exposes one canonical CLI route', async () => {
  const calls: CliBrokerRequest[] = [];
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    calls.push(request);
    return Promise.resolve(ready('hello-cli', request));
  };
  const { h, service } = await setup(runner);
  service.update('opencode-cli', {
    surfaces: { native: true, gateway: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  // The API catalog free Zen model exists but must not become a second CLI route.
  const apiModel = h.services.catalog.models.find((model) => model.ref === 'opencode/big-pickle');
  if (!apiModel) throw new Error('Missing catalog fixture');
  h.services.models.replace(OPENCODE, [{ ...apiModel, apiAccessVerified: false }]);
  await h.rpc.providers.setEnabled(OPENCODE, true);

  const verification = await h.rpc.providers.verifyZenCli(CANONICAL);
  expect(verification.ok, verification.message).toBe(true);

  const cliModels = await h.rpc.models.list(ProviderIdSchema.parse('opencode-cli'));
  const row = cliModels.find((model) => model.ref === CANONICAL);
  expect(row).toMatchObject({ free: true, verified: true, transport: 'opencode_cli' });
  // The API ref is never rewritten into a duplicate CLI transport.
  const apiRow = (await h.rpc.models.list(OPENCODE)).find(
    (model) => model.ref === 'opencode/big-pickle',
  );
  expect(apiRow?.transport).not.toBe('opencode_cli');
  expect((await h.rpc.models.list()).filter((model) => model.ref === CANONICAL)).toHaveLength(1);

  const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
  expect((await h.rpc.models.candidates(session.id)).some((model) => model.ref === CANONICAL)).toBe(
    true,
  );

  const created = await h.rpc.gateway.createKey({ name: 'CLI test', profile: 'auto-free' });
  await h.rpc.gateway.updateKey({ id: created.key.id, patch: { allowedModels: [CANONICAL] } });
  expect(
    (await h.rpc.gateway.routing(created.key.id)).eligible.map((item) => item.modelRef),
  ).toContain(CANONICAL);
});

it('streams Gateway tool handoff and accepts caller tool results without touching the workspace', async () => {
  const runner: CliTurnRunner = (request) => {
    if (isVerify(request)) return Promise.resolve(ready('Ready', request));
    const hasResult = request.messages.some((message) => message.role === 'tool');
    if (request.tools.length && !hasResult)
      return Promise.resolve({
        text: '',
        toolCalls: [
          { id: 'call_cli_fixture', name: 'read_file', arguments: { path: 'marker.txt' } },
        ],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: null, reasoningTokens: null },
        responseModel: 'opencode/big-pickle',
      });
    return Promise.resolve(ready('CLI_TOOL_RESULT', request));
  };
  const { h, service } = await setup(runner);
  service.update('opencode-cli', {
    surfaces: { native: true, gateway: true },
    credentialMode: 'installed',
    credentialProvider: null,
  });
  await service.refresh('opencode-cli');
  const broker = getCliBroker(h.services, () => undefined);
  expect((await broker.verify('opencode-cli', CANONICAL)).ok).toBe(true);

  const controller = getGatewayController(h.services);
  if (!controller) throw new Error('gateway controller missing');
  await controller.start({ enabled: true, port: 0, allowLan: false });
  const created = controller.createKey('cli-tools', 'auto-free');
  const token = controller.issueInternalToken(created.key.id);
  const url = `${controller.status.url ?? ''}/v1/chat/completions`;
  const headers = { 'x-ferry-internal-token': token, 'content-type': 'application/json' };
  const tools = [
    {
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object' } },
    },
  ];
  try {
    const first = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: CANONICAL,
        tools,
        messages: [{ role: 'user', content: 'Read the caller marker.' }],
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      choices?: { message?: { tool_calls?: { id: string; function: { name: string } }[] } }[];
    };
    expect(firstBody.choices?.[0]?.message?.tool_calls?.[0]).toMatchObject({
      id: 'call_cli_fixture',
      function: { name: 'read_file' },
    });
    const second = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: CANONICAL,
        tools,
        messages: [
          { role: 'user', content: 'Read the caller marker.' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_cli_fixture',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"marker.txt"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_cli_fixture', content: 'CLI_TOOL_RESULT' },
        ],
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { choices?: { message?: { content?: string } }[] };
    expect(secondBody.choices?.[0]?.message?.content).toBe('CLI_TOOL_RESULT');
    expect(
      h.server.requests.filter((request) => request.url.includes('/chat/completions')),
    ).toHaveLength(0);
    await expect(readFile(join(h.workspacePath, 'marker.txt'))).rejects.toThrow();
  } finally {
    await controller.stop();
  }
});

it('rejects unsupported images/structured responses and preserves tool history/forced tools', () => {
  expect(() =>
    zenConversation({
      model: 'big-pickle',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    zenConversation({
      model: 'big-pickle',
      messages: [],
      response_format: { type: 'json_object' },
    }),
  ).toThrow('Structured');
  const decoded = zenConversation({
    model: 'big-pickle',
    messages: [{ role: 'tool', tool_call_id: 'a', content: 'REAL_RESULT' }],
    tools: [
      { type: 'function', function: { name: 'read', parameters: {} } },
      { type: 'function', function: { name: 'write', parameters: {} } },
    ],
    tool_choice: { type: 'function', function: { name: 'read' } },
  });
  expect(decoded.tools.map((tool) => tool.name)).toEqual(['read']);
  expect(decoded.prompt).toContain('REAL_RESULT');
});
