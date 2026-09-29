import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  authenticateGatewayKey,
  createGatewayKey,
  startGateway,
  type GatewayKey,
  type GatewayRuntime,
} from '../src/index.js';

const created = createGatewayKey({ name: 'tests', profile: 'auto-free' });
const entries: GatewayKey[] = [created.key];
const totals = new Map<string, { requests: number; inputTokens: number; outputTokens: number }>();
const received: Parameters<GatewayRuntime['complete']>[0][] = [];
const runtime: GatewayRuntime = {
  store: {
    list: () => entries,
    put: (value) => {
      const index = entries.findIndex((item) => item.id === value.id);
      if (index < 0) entries.push(value);
      else entries[index] = value;
    },
    delete: (id) => {
      const index = entries.findIndex((item) => item.id === id);
      if (index >= 0) entries.splice(index, 1);
    },
    touch: (id, at) => {
      const key = entries.find((item) => item.id === id);
      if (key) key.lastUsedAt = at;
    },
    usage: (id) => totals.get(id) ?? { requests: 0, inputTokens: 0, outputTokens: 0 },
    recordUsage: (id, inputTokens, outputTokens) => {
      const old = totals.get(id) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
      totals.set(id, {
        requests: old.requests + 1,
        inputTokens: old.inputTokens + inputTokens,
        outputTokens: old.outputTokens + outputTokens,
      });
    },
  },
  models: () => ['openai/gpt-test'],
  complete: (input) => {
    received.push(input);
    if (input.messages.some((message) => message.content === 'quota'))
      return Promise.reject(
        Object.assign(new Error('provider quota exhausted'), { statusCode: 429 }),
      );
    input.onText?.('Hello');
    if (input.tools?.length)
      input.onToolCall?.({ id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' });
    return Promise.resolve({
      id: 'response-1',
      model: 'openai/gpt-test',
      text: 'Hello',
      inputTokens: 4,
      outputTokens: 2,
      finishReason: 'stop',
      toolCalls: input.tools?.length
        ? [{ id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }]
        : [],
    });
  },
};
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  entries.splice(0, entries.length, created.key);
  created.key.revokedAt = null;
  created.key.allowedModels = [];
  created.key.rateLimit = null;
  totals.clear();
  received.splice(0);
});

async function server() {
  const handle = await startGateway({ runtime, port: 0 });
  stop = () => handle.close();
  return `http://127.0.0.1:${String(handle.port)}`;
}

describe('Ferry gateway', () => {
  it('stores only a key hash and uses constant-time compatible authentication', () => {
    expect(created.secret).toMatch(/^ferry-gw-/);
    expect(created.key.hash).not.toContain(created.secret);
    expect(JSON.stringify(entries)).not.toContain(created.secret);
    expect(authenticateGatewayKey(created.secret, entries)?.id).toBe(created.key.id);
    expect(authenticateGatewayKey('ferry-gw-invalid', entries)).toBeUndefined();
    created.key.revokedAt = new Date().toISOString();
    expect(authenticateGatewayKey(created.secret, entries)).toBeUndefined();
  });

  it('serves OpenAI non-streaming completions and usage accounting', async () => {
    const url = await server();
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ferry/auto-free',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    expect(payload.choices[0]?.message.content).toBe('Hello');
    expect(payload.usage.total_tokens).toBe(6);
    expect(runtime.store.usage(created.key.id).requests).toBe(1);
  }, 30_000);

  it('streams OpenAI chunks, tools, usage, and Anthropic messages events', async () => {
    const url = await server();
    const headers = {
      authorization: `Bearer ${created.secret}`,
      'content-type': 'application/json',
    };
    const openai = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'ferry/fast',
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    const chunks = await openai.text();
    expect(chunks).toContain('chat.completion.chunk');
    expect(chunks).toContain('tool_calls');
    expect(chunks).toContain('[DONE]');
    const anthropic = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'x-api-key': created.secret },
      body: JSON.stringify({
        model: 'ferry/best',
        stream: true,
        max_tokens: 64,
        tools: [
          {
            name: 'lookup',
            input_schema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    const events = await anthropic.text();
    expect(events).toContain('event: message_start');
    expect(events).toContain('event: content_block_delta');
    expect(events).toContain('event: message_stop');
    expect(events).toContain('tool_use');
    expect(runtime.store.usage(created.key.id).requests).toBe(2);
  }, 30_000);

  it('accepts captured OpenCode, Cline/Roo, Aider, and Claude Code request shapes', async () => {
    const url = await server();
    const headers = {
      authorization: `Bearer ${created.secret}`,
      'content-type': 'application/json',
    };
    const fixtures = [
      ['opencode.json', '/v1/chat/completions'],
      ['cline-roo.json', '/v1/chat/completions'],
      ['aider.json', '/v1/chat/completions'],
      ['claude-code.json', '/v1/messages'],
    ] as const;
    for (const [fixture, path] of fixtures) {
      const payload = JSON.parse(
        await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'),
      ) as Record<string, unknown>;
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      expect(response.status, fixture).toBe(200);
      expect(await response.text(), fixture).toContain(
        path.endsWith('/messages') ? 'message_start' : 'chat.completion',
      );
    }
    expect(received).toHaveLength(4);
    expect(received[0]?.instructions).toContain('expert programming assistant');
    expect(received[0]?.instructions).toContain('Use concise progress updates');
    expect(
      received[0]?.messages.some(
        (message) => message.role === 'system' || message.role === 'developer',
      ),
    ).toBe(false);
    expect(received[0]?.tools).toHaveLength(15);
    expect(received[0]?.toolChoice).toBe('auto');
    expect(received[1]?.instructions).toContain('coding assistant working');
    expect(received[1]?.tools).toHaveLength(3);
    expect(received[2]?.instructions).toContain('expert software developer');
    expect(received[2]?.tools).toBeUndefined();
    expect(received[3]?.instructions).toContain('interactive coding assistant');
    expect(received[3]?.instructions).toContain('Preserve the user');
    expect(received[3]?.tools).toHaveLength(3);
    expect(received[3]?.messages.some((message) => message.role === 'system')).toBe(false);
  }, 30_000);

  it('rejects unsupported images and maps SDK prompt errors to HTTP 400', async () => {
    const url = await server();
    const headers = {
      authorization: `Bearer ${created.secret}`,
      'content-type': 'application/json',
    };
    const image = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'ferry/auto-free',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }],
      }),
    });
    expect(image.status).toBe(400);
    expect(((await image.json()) as { error: { message: string } }).error.message).toContain(
      'not supported yet',
    );

    const invalidRuntime: GatewayRuntime = {
      ...runtime,
      complete: () =>
        Promise.reject(
          Object.assign(new Error('Bad message schema'), { name: 'AI_InvalidPromptError' }),
        ),
    };
    const handle = await startGateway({ runtime: invalidRuntime, port: 0 });
    stop = () => handle.close();
    const invalid = await fetch(`http://127.0.0.1:${String(handle.port)}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'ferry/auto-free',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(
      ((await invalid.json()) as { error: { type: string; message: string } }).error,
    ).toMatchObject({
      type: 'invalid_request_error',
      message: 'Bad message schema',
    });
  }, 30_000);

  it('rejects missing, revoked, and unknown model credentials with compatible errors', async () => {
    const url = await server();
    const missing = await fetch(`${url}/v1/models`);
    expect(missing.status).toBe(401);
    const unknown = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-api-key': created.secret, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unknown/model', messages: [] }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { type: string } }).error.type).toBe(
      'model_not_found',
    );
    created.key.revokedAt = new Date().toISOString();
    const revoked = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(revoked.status).toBe(401);
  }, 30_000);

  it('limits advertised models to each key allowlist', async () => {
    const url = await server();
    created.key.allowedModels = ['openai/gpt-test'];
    const concreteOnly = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(
      ((await concreteOnly.json()) as { data: { id: string }[] }).data.map((item) => item.id),
    ).toEqual(['openai/gpt-test']);
    created.key.allowedModels = ['ferry/fast'];
    const aliasOnly = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(
      ((await aliasOnly.json()) as { data: { id: string }[] }).data.map((item) => item.id),
    ).toEqual(['ferry/fast']);
  }, 30_000);

  it('maps provider quota errors and binds localhost unless LAN access is explicitly enabled', async () => {
    const handle = await startGateway({ runtime, port: 0 });
    stop = () => handle.close();
    expect(handle.host).toBe('127.0.0.1');
    const models = await fetch(`http://127.0.0.1:${String(handle.port)}/v1/models`, {
      headers: { authorization: `Bearer ${created.secret}` },
    });
    const payload = (await models.json()) as { data: { id: string }[] };
    expect(payload.data.map(({ id }) => id)).toContain('ferry/auto-free');
    expect(payload.data.map(({ id }) => id)).toContain('openai/gpt-test');
    const failure = await fetch(`http://127.0.0.1:${String(handle.port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ferry/auto-free',
        messages: [{ role: 'user', content: 'quota' }],
      }),
    });
    expect(failure.status).toBe(429);
    expect(((await failure.json()) as { error: { code: string } }).error.code).toBe(
      'quota_exhausted',
    );
  }, 30_000);

  it('enforces optional per-key requests per minute', async () => {
    const url = await server();
    created.key.rateLimit = 1;
    const request = () =>
      fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'ferry/auto-free',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  }, 30_000);
});
