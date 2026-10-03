import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import {
  authenticateGatewayKey,
  createGatewayKey,
  pruneRateState,
  startGateway,
  type GatewayKey,
  type GatewayRuntime,
} from '../src/index.js';

const created = createGatewayKey({ name: 'tests', profile: 'auto-free' });
const entries: GatewayKey[] = [created.key];
const totals = new Map<
  string,
  {
    requests: number;
    successfulRequests: number;
    inputTokens: number;
    outputTokens: number;
    tokenEvents: { at: string; tokens: number }[];
    requestEvents: string[];
  }
>();
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
    usage: (id) =>
      totals.get(id) ?? {
        requests: 0,
        successfulRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokenEvents: [],
        requestEvents: [],
      },
    recordRequest: (id, at) => {
      const old = totals.get(id) ?? {
        requests: 0,
        successfulRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokenEvents: [],
        requestEvents: [],
      };
      totals.set(id, {
        ...old,
        requests: old.requests + 1,
        requestEvents: [...old.requestEvents, at],
      });
    },
    recentRequests: (id, now) =>
      (totals.get(id)?.requestEvents ?? []).filter(
        (at) => Date.parse(now) - Date.parse(at) < 60_000,
      ).length,
    tokenUsage: (id, now) => {
      const old = totals.get(id);
      const events = old?.tokenEvents ?? [];
      return {
        minuteTokens: events
          .filter((event) => Date.parse(now) - Date.parse(event.at) < 60_000)
          .reduce((sum, event) => sum + event.tokens, 0),
        dayTokens: events
          .filter((event) => event.at.slice(0, 10) === now.slice(0, 10))
          .reduce((sum, event) => sum + event.tokens, 0),
      };
    },
    recordUsage: (id, inputTokens, outputTokens, at) => {
      const old = totals.get(id) ?? {
        requests: 0,
        successfulRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokenEvents: [],
        requestEvents: [],
      };
      totals.set(id, {
        ...old,
        successfulRequests: old.successfulRequests + 1,
        inputTokens: old.inputTokens + inputTokens,
        outputTokens: old.outputTokens + outputTokens,
        tokenEvents: [...old.tokenEvents, { at, tokens: inputTokens + outputTokens }],
      });
    },
  },
  models: () => ['openai/gpt-test', 'gpt-test-logical'],
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
  created.key.tokenLimitPerMinute = null;
  created.key.tokenLimitPerDay = null;
  created.key.concurrencyLimit = null;
  totals.clear();
  received.splice(0);
});

async function server() {
  const handle = await startGateway({ runtime, port: 0 });
  stop = () => handle.close();
  return `http://127.0.0.1:${String(handle.port)}`;
}

describe('Ferry gateway', () => {
  it('prunes rate state older than one minute', () => {
    const state = new Map([
      ['expired', [-1, 0]],
      ['active', [10, 59_999]],
    ]);
    pruneRateState(state, 60_000);
    expect(state.has('expired')).toBe(false);
    expect(state.get('active')).toEqual([10, 59_999]);
  });

  it('stores only a key hash and uses constant-time compatible authentication', () => {
    expect(created.secret).toMatch(/^ferry-gw-/);
    expect(created.key.hash).not.toContain(created.secret);
    expect(JSON.stringify(entries)).not.toContain(created.secret);
    expect(authenticateGatewayKey(created.secret, entries)?.id).toBe(created.key.id);
    expect(authenticateGatewayKey('ferry-gw-invalid', entries)).toBeUndefined();
    created.key.revokedAt = new Date().toISOString();
    expect(authenticateGatewayKey(created.secret, entries)).toBeUndefined();
  });

  it('rejects browser origins and throttles repeated invalid authentication', async () => {
    const url = await server();
    const browser = await fetch(`${url}/v1/models`, {
      headers: { origin: 'https://attacker.invalid', authorization: `Bearer ${created.secret}` },
    });
    expect(browser.status).toBe(403);
    expect(browser.headers.get('access-control-allow-origin')).toBeNull();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${url}/v1/models`, {
        headers: { authorization: 'Bearer ferry-gw-invalid' },
      });
      expect(response.status).toBe(401);
    }
    const throttled = await fetch(`${url}/v1/models`, {
      headers: { authorization: 'Bearer ferry-gw-invalid' },
    });
    expect(throttled.status).toBe(429);
  }, 30_000);

  it('requires explicit confirmation before binding the gateway to LAN interfaces', async () => {
    await expect(startGateway({ runtime, port: 0, allowLan: true })).rejects.toThrow(
      /explicit confirmation/,
    );
    const handle = await startGateway({
      runtime,
      port: 0,
      allowLan: true,
      allowLanConfirmed: true,
    });
    stop = () => handle.close();
    expect(handle.host).toBe('0.0.0.0');
  }, 30_000);

  it('retries a busy port on an ephemeral port and resolves readiness', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const handle = await startGateway({ runtime, port: address.port });
    stop = () => handle.close();
    expect(handle.port).not.toBe(address.port);
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }, 30_000);

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
    expect(received.at(-1)?.model).toBe('@profile:auto-free');
  }, 30_000);

  it('serves Responses and native Gemini requests, including their SSE forms', async () => {
    const url = await server();
    const headers = {
      authorization: `Bearer ${created.secret}`,
      'content-type': 'application/json',
    };
    const responses = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'ferry/auto-free', input: 'hello' }),
    });
    expect(responses.status).toBe(200);
    expect(await responses.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      output_text: 'Hello',
      usage: { input_tokens: 4, output_tokens: 2 },
    });

    const responsesTool = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'ferry/auto-free',
        input: 'look this up',
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      }),
    });
    expect(await responsesTool.json()).toMatchObject({
      output: [
        { type: 'message' },
        { type: 'function_call', name: 'lookup', arguments: '{"q":"x"}' },
      ],
    });

    const unsupportedContinuation = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'ferry/auto-free',
        previous_response_id: 'resp_old',
        input: 'continue',
      }),
    });
    expect(unsupportedContinuation.status).toBe(400);
    expect(await unsupportedContinuation.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        message: 'previous_response_id is not supported by Ferry Gateway',
      },
    });

    const responsesStream = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'ferry/auto-free', input: 'hello', stream: true }),
    });
    expect(await responsesStream.text()).toContain('event: response.completed');

    const gemini = await fetch(`${url}/v1beta/models/ferry%2Fauto-free:generateContent`, {
      method: 'POST',
      headers: { ...headers, 'x-api-key': created.secret },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }),
    });
    expect(gemini.status).toBe(200);
    expect(await gemini.json()).toMatchObject({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }],
      usageMetadata: { totalTokenCount: 6 },
    });

    const geminiTool = await fetch(`${url}/v1beta/models/ferry%2Fauto-free:generateContent`, {
      method: 'POST',
      headers: { ...headers, 'x-api-key': created.secret },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'look this up' }] }],
        tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }] }],
      }),
    });
    expect(await geminiTool.json()).toMatchObject({
      candidates: [
        { content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] } },
      ],
    });

    const geminiStream = await fetch(
      `${url}/v1beta/models/ferry%2Fauto-free:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { ...headers, 'x-api-key': created.secret },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }),
      },
    );
    expect(geminiStream.headers.get('content-type')).toContain('text/event-stream');
    expect(await geminiStream.text()).toContain('usageMetadata');
  }, 30_000);

  it('passes logical names and concrete provider/model refs through the gateway contract', async () => {
    const url = await server();
    const headers = {
      authorization: `Bearer ${created.secret}`,
      'content-type': 'application/json',
    };
    for (const model of ['gpt-test-logical', 'openai/gpt-test']) {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(received.map((input) => input.model)).toEqual(['gpt-test-logical', 'openai/gpt-test']);
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

  it('returns an OpenAI-compatible classified error chunk when a provider fails mid-stream', async () => {
    const failingRuntime: GatewayRuntime = {
      ...runtime,
      complete: (input) => {
        input.onText?.('partial');
        return Promise.reject(
          Object.assign(
            new Error('stream wrapper failed', {
              cause: Object.assign(new Error('upstream unavailable'), { statusCode: 503 }),
            }),
            { name: 'AI_StreamProviderError' },
          ),
        );
      },
    };
    const handle = await startGateway({ runtime: failingRuntime, port: 0 });
    stop = () => handle.close();
    const response = await fetch(`http://127.0.0.1:${String(handle.port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ferry/auto-free',
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const errorLine = body.split('\n').find((line) => line.startsWith('data: {"error"'));
    expect(errorLine).toBeDefined();
    if (!errorLine) throw new Error('Expected an OpenAI-compatible SSE error event');
    expect(JSON.parse(errorLine.slice(6))).toMatchObject({
      error: { type: 'server_error', code: 'server', message: 'upstream unavailable' },
    });
    expect(body).toContain('data: [DONE]');
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
  it('enforces token budgets with OpenAI and Anthropic rate-limit errors', async () => {
    const handle = await startGateway({ runtime, port: 0 });
    stop = () => handle.close();
    created.key.tokenLimitPerMinute = 1;
    const openAi = await fetch(`http://127.0.0.1:${String(handle.port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ferry/auto-free',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(openAi.status).toBe(429);
    expect(openAi.headers.get('retry-after')).toBe('60');
    expect(await openAi.json()).toMatchObject({ error: { type: 'rate_limit_error' } });

    created.key.tokenLimitPerMinute = null;
    created.key.tokenLimitPerDay = 1;
    const anthropic = await fetch(`http://127.0.0.1:${String(handle.port)}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': created.secret, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ferry/auto-free',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(anthropic.status).toBe(429);
    expect(anthropic.headers.get('retry-after')).toBeTruthy();
    expect(await anthropic.json()).toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error' },
    });
  }, 30_000);
  it('limits concurrent requests and counts total separately from successful calls', async () => {
    let begin: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => (begin = resolve));
    const paused = new Promise<void>((resolve) => (finish = resolve));
    const slowRuntime: GatewayRuntime = {
      ...runtime,
      complete: async () => {
        begin?.();
        await paused;
        throw new Error('failed after provider attempt');
      },
    };
    const handle = await startGateway({ runtime: slowRuntime, port: 0 });
    stop = () => handle.close();
    created.key.concurrencyLimit = 1;
    const request = () =>
      fetch(`http://127.0.0.1:${String(handle.port)}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${created.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'ferry/auto-free',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
    const first = request();
    await entered;
    const second = await request();
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    finish?.();
    expect((await first).status).toBe(500);
    expect(runtime.store.usage(created.key.id)).toMatchObject({
      requests: 1,
      successfulRequests: 0,
    });
  }, 30_000);
});
