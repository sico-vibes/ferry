import { expect, it, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isOpenCodeAppModel, ProviderIdSchema } from '@ferry/shared';
import type { ZenAcpInput } from '@ferry/delegate';
import { startHarness, waitFor } from './qa-w3-harness.js';
import { zenConversation } from '../src/zen-cli.js';
vi.setConfig({ testTimeout: 30_000 });
const calls = vi.hoisted(() => [] as ZenAcpInput[]);
vi.mock('@ferry/delegate', async (original) => ({
  ...(await original<typeof import('@ferry/delegate')>()),
  runZenAcp: vi.fn((input: ZenAcpInput) => {
    calls.push(input);
    if (input.tools?.length && !input.prompt.includes('CLI_TOOL_RESULT'))
      return Promise.resolve({
        text: '',
        toolCalls: [
          {
            id: 'call_cli_fixture',
            name:
              input.tools.find((tool) => tool.name === 'read_file')?.name ?? input.tools[0]?.name,
            arguments: { path: 'marker.txt' },
          },
        ],
        inputTokens: 0,
        outputTokens: 0,
      });
    const text = input.prompt.includes('CLI_TOOL_RESULT') ? 'CLI_TOOL_RESULT' : 'Ready.';
    input.onText?.(text);
    return Promise.resolve({ text, toolCalls: [], inputTokens: 12, outputTokens: 2 });
  }),
}));

it('separates CLI verification from API access and makes keyless CLI available in picker and Gateway', async () => {
  const h = await startHarness({ provider: 'opencode' });
  try {
    const model = h.services.catalog.models.find(
      (model) => model.providerId === 'opencode' && model.free,
    );
    const provider = h.services.providers.get('opencode');
    if (!model || !provider) throw new Error('Missing fixture');
    h.services.models.replace('opencode', [{ ...model, apiAccessVerified: false }]);
    h.services.providers.put({ ...provider, freeTierUnsupported: true, health: 'auth_invalid' });
    await h.rpc.settings.update({ opencodeZenTransport: 'cli' });
    expect((await h.rpc.providers.verifyZenCli(model.ref)).ok).toBe(true);
    expect(h.services.providers.get('opencode')?.health).toBe('ok');
    h.services.providerKeys.delete(ProviderIdSchema.parse('opencode'));
    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    const listed = (await h.rpc.models.list(ProviderIdSchema.parse('opencode'))).find(
      (item) => item.ref === model.ref,
    );
    expect(listed).toMatchObject({
      free: true,
      cliAccessVerified: true,
      apiAccessVerified: false,
      transport: 'opencode_cli',
      inputModalities: ['text'],
    });
    expect(listed && isOpenCodeAppModel(listed)).toBe(false);
    expect((await h.rpc.models.candidates(session.id)).some((item) => item.ref === model.ref)).toBe(
      true,
    );
    const created = await h.rpc.gateway.createKey({
      name: 'CLI test',
      profile: 'none',
    });
    await h.rpc.gateway.updateKey({ id: created.key.id, patch: { allowedModels: [model.ref] } });
    expect(
      (await h.rpc.gateway.routing(created.key.id)).eligible.map((item) => item.modelRef),
    ).toContain(model.ref);
    await h.rpc.settings.update({ opencodeZenTransport: 'api' });
    expect((await h.rpc.models.candidates(session.id)).some((item) => item.ref === model.ref)).toBe(
      false,
    );
    expect(
      (await h.rpc.gateway.routing(created.key.id)).eligible.map((item) => item.modelRef),
    ).not.toContain(model.ref);
  } finally {
    await h.close();
  }
});

it('streams Gateway tool handoff and accepts caller tool results without touching the gateway workspace', async () => {
  const h = await startHarness({ provider: 'opencode' });
  try {
    const model = h.services.catalog.models.find(
      (model) => model.providerId === 'opencode' && model.free,
    );
    if (!model) throw new Error('Missing fixture');
    h.services.models.replace('opencode', [
      { ...model, apiAccessVerified: false, cliAccessVerified: true },
    ]);
    await h.rpc.settings.update({ opencodeZenTransport: 'cli' });
    const created = await h.rpc.gateway.createKey({
      name: 'CLI test',
      profile: 'none',
    });
    await h.rpc.gateway.updateKey({ id: created.key.id, patch: { allowedModels: [model.ref] } });
    const state = (await h.rpc.gateway.setSettings({
      enabled: true,
      port: 0,
      allowLan: false,
    })) as { status: { url: string } };
    const post = (messages: unknown[], tools?: unknown[]) =>
      fetch(`${state.status.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.ref, messages, tools, stream: true, max_tokens: 32 }),
      });
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ];
    const initial = [{ role: 'user', content: 'Read the caller marker.' }];
    const first = await post(initial, tools);
    expect(first.status).toBe(200);
    const wire = await first.text();
    expect(wire).toContain('call_cli_fixture');
    expect(wire).toContain('read_file');
    expect(wire).toContain('tool_calls');
    expect(wire).toContain('[DONE]');
    const continued = await post(
      [
        ...initial,
        {
          role: 'assistant',
          content: null,
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
      tools,
    );
    expect(await continued.text()).toContain('CLI_TOOL_RESULT');
    expect(
      h.server.requests.filter((request) => request.url.includes('/chat/completions')),
    ).toHaveLength(0);
    expect(calls.at(-1)?.prompt).toContain('CLI_TOOL_RESULT');
    await expect(readFile(join(h.workspacePath, 'marker.txt'))).rejects.toThrow();
  } finally {
    await h.close();
  }
});

it('Ferry executes a CLI tool through its own tool loop and returns the real file output', async () => {
  const h = await startHarness({ provider: 'opencode' });
  try {
    const model = h.services.catalog.models.find(
      (model) => model.providerId === 'opencode' && model.free && model.toolCalling,
    );
    if (!model) throw new Error('Missing fixture');
    h.services.models.replace('opencode', [
      { ...model, apiAccessVerified: false, cliAccessVerified: true },
    ]);
    await h.rpc.settings.update({ opencodeZenTransport: 'cli', permissionMode: 'full_auto' });
    const now = new Date().toISOString();
    h.services.providerKeyEntries.put({
      id: 'opencode:1',
      providerId: 'opencode',
      keyId: '1',
      label: 'API key',
      position: 0,
      enabled: true,
      status: 'invalid',
      lastError: 'API credential rejected',
      cooldownUntil: null,
      keyringRef: 'opencode',
      createdAt: now,
      updatedAt: now,
    });
    const before = h.services.providerKeyEntries.list('opencode');
    await writeFile(join(h.workspacePath, 'marker.txt'), 'CLI_TOOL_RESULT', 'utf8');
    const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
    await h.rpc.models.select(session.id, model.ref);
    await h.rpc.sessions.send(session.id, { text: 'Read marker.txt and quote its content.' });
    await waitFor(async () =>
      (await h.rpc.sessions.get(session.id)).messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.parts.some(
            (part) => part.type === 'text' && part.text.includes('CLI_TOOL_RESULT'),
          ),
      ),
    );
    expect(calls.at(-1)?.prompt).toContain('CLI_TOOL_RESULT');
    expect(calls.at(-1)?.apiKey).toBeUndefined();
    expect(h.services.providerKeyEntries.list('opencode')).toEqual(before);
    expect(
      h.server.requests.filter((request) => request.url.includes('/chat/completions')),
    ).toHaveLength(0);
  } finally {
    await h.close();
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
