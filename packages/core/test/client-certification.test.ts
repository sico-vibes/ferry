/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matchers are intentionally untyped assertion values. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { startHarness, textTurn, toolTurn, type CoreHarness } from './qa-w3-harness.js';

// Recorded client wire shapes, rather than SDK mocks. No external clients or accounts are
// invoked in CI; each exchange traverses HTTP, Core routing, the adapter and SQLite.
vi.setConfig({ testTimeout: 30_000 });
let h: CoreHarness;
let endpoint: string;
let secret: string;
beforeAll(async () => {
  h = await startHarness();
  const model = h.services.catalog.models.find(
    (model) =>
      model.providerId === 'openrouter' &&
      model.free &&
      model.toolCalling &&
      /:free(?:$|:)/i.test(model.ref),
  );
  if (!model) throw new Error('Missing free certification model');
  h.services.models.replace('openrouter', [model]);
  const created = await h.rpc.gateway.createKey({ name: 'Client certification', profile: 'none' });
  await h.rpc.gateway.updateKey({ id: created.key.id, patch: { allowedModels: [model.ref] } });
  secret = created.secret;
  const started = (await h.rpc.gateway.setSettings({
    enabled: true,
    port: 0,
    allowLan: false,
  })) as { status: { url: string } };
  endpoint = started.status.url;
});
beforeEach(() => {
  h.server.requests.splice(0);
  h.server.setResponses([
    toolTurn('read_file', { path: "notes/it's-日本語.txt" }),
    textTurn('CERTIFIED'),
  ]);
});
afterAll(async () => h.close());

const parameters = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../gateway/test/fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}
async function post(path: string, body: unknown, anthropic = false) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(anthropic
        ? {
            'x-api-key': secret,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'interleaved-thinking-2025-05-14',
          }
        : { authorization: `Bearer ${secret}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response;
}
function frames(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && !line.endsWith('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
function assertUpstreamFollowUp(name = 'read_file', schema: unknown = parameters) {
  const requests = h.server.requests.filter((request) => request.url.endsWith('/chat/completions'));
  expect(requests).toHaveLength(2);
  const body = requests[1]?.body as { messages: unknown[]; tools: unknown[] };
  expect(body.messages).toContainEqual(
    expect.objectContaining({
      role: 'tool',
      tool_call_id: 'call_qa_1',
      content: 'fixture contents 日本語',
    }),
  );
  expect(body.tools).toContainEqual(
    expect.objectContaining({
      function: expect.objectContaining({ name, parameters: schema }),
    }),
  );
}

it.each(['OpenCode', 'generic OpenAI HTTP'])(
  '%s streams tools and submits a complete tool-result conversation',
  async (client) => {
    const recorded = fixture('opencode');
    const toolName = client === 'OpenCode' ? 'read' : 'read_file';
    const args =
      client === 'OpenCode'
        ? { filePath: "notes/it's-日本語.txt" }
        : { path: "notes/it's-日本語.txt" };
    h.server.setResponses([toolTurn(toolName, args), textTurn('CERTIFIED')]);
    const tools =
      client === 'OpenCode'
        ? (recorded.tools as { type: string; function: { name: string; parameters: unknown } }[])
        : [
            {
              type: 'function',
              function: { name: 'read_file', description: 'Read a file', parameters },
            },
          ];
    const messages =
      client === 'OpenCode'
        ? (recorded.messages as unknown[])
        : [
            { role: 'system', content: 'Keep tool arguments intact.' },
            { role: 'user', content: 'Read the notes.' },
          ];
    const first = await post('/v1/chat/completions', {
      model: 'ferry/auto',
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    });
    const wire = await first.text();
    expect(wire).toContain('[DONE]');
    const chunks = frames(wire) as {
      choices?: {
        delta?: {
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string;
      }[];
    }[];
    const calls = chunks.flatMap(
      (chunk) => chunk.choices?.flatMap((choice) => choice.delta?.tool_calls ?? []) ?? [],
    );
    expect(calls.some((call) => call.id === 'call_qa_1' && call.function?.name === toolName)).toBe(
      true,
    );
    expect(JSON.parse(calls.map((call) => call.function?.arguments ?? '').join(''))).toEqual(args);
    expect(
      chunks.some((chunk) =>
        chunk.choices?.some((choice) => choice.finish_reason === 'tool_calls'),
      ),
    ).toBe(true);
    const second = await post('/v1/chat/completions', {
      model: 'ferry/auto',
      tools,
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_qa_1',
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_qa_1', content: 'fixture contents 日本語' },
      ],
      stream: false,
    });
    expect(await second.json()).toMatchObject({
      choices: [{ message: { content: 'CERTIFIED' }, finish_reason: 'stop' }],
    });
    assertUpstreamFollowUp(
      toolName,
      tools.find((tool) => tool.function.name === toolName)?.function.parameters,
    );
  },
);

it('Codex CLI uses stateless Responses SSE with replayed function calls and output', async () => {
  const recorded = fixture('codex');
  const tools = recorded.tools as { type: string; name: string; parameters: unknown }[];
  const input = (recorded.input as unknown[]).slice(0, 2);
  const first = await post('/v1/responses', {
    model: 'ferry/auto',
    store: false,
    stream: true,
    input,
    tools,
    instructions: recorded.instructions,
    reasoning: { effort: 'medium' },
    parallel_tool_calls: true,
  });
  const events = frames(await first.text());
  expect(events[0]?.type).toBe('response.created');
  const done = events.find((event) => event.type === 'response.completed') as
    | { response: { output: { type: string; call_id: string; name: string; arguments: string }[] } }
    | undefined;
  const call = done?.response.output.find((item) => item.type === 'function_call');
  expect(call).toMatchObject({ call_id: 'call_qa_1', name: 'read_file' });
  const second = await post('/v1/responses', {
    model: 'ferry/auto',
    instructions: recorded.instructions,
    reasoning: recorded.reasoning,
    store: false,
    stream: true,
    tools,
    input: [
      ...input,
      call,
      { type: 'function_call_output', call_id: call?.call_id, output: 'fixture contents 日本語' },
    ],
  });
  const wire = await second.text();
  expect(wire).toContain('response.output_text.delta');
  expect(wire).toContain('CERTIFIED');
  expect(frames(wire).at(-1)?.type).toBe('response.completed');
  assertUpstreamFollowUp('read_file', tools[0]?.parameters);
});

it('Claude Code uses Messages SSE, x-api-key, stop reasons and tool_use/tool_result blocks', async () => {
  const recorded = fixture('claude-code');
  const tools = recorded.tools as { name: string; input_schema: unknown }[];
  const messages = recorded.messages as unknown[];
  h.server.setResponses([
    toolTurn('Read', { file_path: "notes/it's-日本語.txt" }),
    textTurn('CERTIFIED'),
  ]);
  const first = await post(
    '/v1/messages',
    {
      model: 'ferry/auto',
      system: recorded.system,
      thinking: recorded.thinking,
      max_tokens: 1024,
      messages,
      tools,
      stream: true,
    },
    true,
  );
  const events = frames(await first.text());
  expect(events[0]?.type).toBe('message_start');
  expect(events.at(-1)?.type).toBe('message_stop');
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'message_delta',
      delta: expect.objectContaining({ stop_reason: 'tool_use' }),
    }),
  );
  const start = events.find(
    (event) => (event.content_block as { type?: string } | undefined)?.type === 'tool_use',
  ) as { content_block: { id: string; name: string } } | undefined;
  expect(start?.content_block).toMatchObject({ id: 'call_qa_1', name: 'Read' });
  const second = await post(
    '/v1/messages',
    {
      model: 'ferry/auto',
      system: recorded.system,
      thinking: recorded.thinking,
      max_tokens: 1024,
      stream: true,
      tools,
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: start?.content_block.id,
              name: 'Read',
              input: { file_path: "notes/it's-日本語.txt" },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: start?.content_block.id,
              content: 'fixture contents 日本語',
            },
          ],
        },
      ],
    },
    true,
  );
  const wire = await second.text();
  expect(
    frames(wire)
      .map((event) => (event.delta as { text?: string } | undefined)?.text ?? '')
      .join(''),
  ).toBe('CERTIFIED');
  expect(frames(wire)).toContainEqual(
    expect.objectContaining({
      type: 'message_delta',
      delta: expect.objectContaining({ stop_reason: 'end_turn' }),
    }),
  );
  assertUpstreamFollowUp('Read', tools[0]?.input_schema);
});
