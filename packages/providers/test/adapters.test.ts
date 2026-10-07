import { afterEach, describe, expect, it } from 'vitest';
import { streamText } from 'ai';
import { z } from 'zod';
import {
  ModelRefSchema,
  ProbeResultSchema,
  RawCallObservationSchema,
  UsageRecordSchema,
  ProviderRequestOverridesSchema,
  type RawCallObservation,
} from '@ferry/shared';
import { FakeOpenAIServer, FakeProviderServer } from '@ferry/testkit';
import {
  createLanguageModel,
  createObservedFetch,
  mapProviderError,
  mergeUsage,
  probe,
  streamProviderChat,
  resolveProviderRequestOverrides,
} from '../src/index.js';

const servers: FakeProviderServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('provider adapters', () => {
  it('reports the post-override upstream model while retaining the requested model', async () => {
    const observations: RawCallObservation[] = [];
    let body = '';
    const fetcher = createObservedFetch(
      (value) => observations.push(value),
      { providerId: 'openai', model: 'requested/model' },
      (_input, init) => {
        body = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      { ...ProviderRequestOverridesSchema.parse({}), forceParams: { model: 'upstream-x' } },
    );
    await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'original', messages: [] }),
    });
    expect(JSON.parse(body)).toMatchObject({ model: 'upstream-x' });
    expect(observations[0]).toMatchObject({
      requestedModel: 'requested/model',
      upstreamModel: 'upstream-x',
    });
  });
  it('applies catalog and user request overrides and remaps quota errors for routing', async () => {
    let sentBody: Record<string, unknown> = {};
    let sentHeaders = new Headers();
    let observationStatus: number | null | undefined;
    const overrides = resolveProviderRequestOverrides('openrouter', {
      stripParams: ['temperature'],
      forceParams: { parallel_tool_calls: false, max_tokens: 77 },
      headers: { 'X-Ferry-Test': 'enabled' },
      statusRemaps: [{ from: 400, to: 429, messageIncludes: 'quota exceeded' }],
    });
    const observed = createObservedFetch(
      (observation) => {
        observationStatus = observation.statusCode;
      },
      { providerId: 'openrouter', model: 'openrouter/test-model' },
      (_input, init) => {
        const body = init?.body;
        sentBody = JSON.parse(typeof body === 'string' ? body : '') as Record<string, unknown>;
        sentHeaders = new Headers(init?.headers);
        return Promise.resolve(
          new Response('{"error":{"message":"quota exceeded"}}', { status: 400 }),
        );
      },
      overrides,
    );
    const response = await observed('https://provider.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', temperature: 0.4, max_tokens: 10 }),
    });
    expect(sentBody).toEqual({ model: 'test-model', max_tokens: 77, parallel_tool_calls: false });
    expect(sentHeaders.get('X-Ferry-Test')).toBe('enabled');
    expect(sentHeaders.get('HTTP-Referer')).toBe('https://ferry.dev');
    expect(response.status).toBe(429);
    expect(observationStatus).toBe(429);
    expect(mapProviderError({ statusCode: response.status, message: 'quota exceeded' }).kind).toBe(
      'quota_exhausted',
    );
  });

  it('constructs SDK models for supported native and compatible providers', () => {
    const refs = [
      'gemini/gemini-2.5-flash',
      'anthropic/claude-sonnet-4',
      'openai/gpt-4.1-mini',
      'openrouter/openai/gpt-4.1-mini',
      'groq/llama-3.3-70b-versatile',
      'cerebras/qwen-3-32b',
      'nvidia/meta/llama-3.1-8b-instruct',
      'mistral/mistral-small-latest',
      'deepseek/deepseek-chat',
      'opencode/claude-sonnet-4',
      'opencode-go/claude-sonnet-4',
      'custom/model-name',
    ];
    for (const ref of refs) {
      expect(() =>
        createLanguageModel(ModelRefSchema.parse(ref), {
          apiKey: 'fake-key',
          ...(ref.startsWith('custom/') ? { baseUrl: 'http://127.0.0.1:9999/v1' } : {}),
          sessionId: 'session-test',
        }),
      ).not.toThrow();
    }
    expect(() =>
      createLanguageModel(ModelRefSchema.parse('custom/model'), { apiKey: 'fake-key' }),
    ).toThrow(/baseUrl/);
  });

  it('maps normalized NVIDIA refs back to the NVIDIA API model id', async () => {
    const fake = await new FakeOpenAIServer({
      responses: [
        {
          body: {
            id: 'chatcmpl_nvidia',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        },
      ],
    }).start();
    servers.push(fake);
    const model = createLanguageModel(ModelRefSchema.parse('nvidia/nemotron-3-super-120b'), {
      apiKey: 'fixture-key',
      baseUrl: `${fake.baseUrl}/v1`,
    });
    await streamText({ model, prompt: 'hello' }).text;
    expect(fake.requests[0]?.body).toMatchObject({ model: 'nvidia/nemotron-3-super-120b' });
  });

  it('sends Gateway internal tokens only in the internal header and uses the configured route model', async () => {
    const fake = await new FakeOpenAIServer().start();
    servers.push(fake);
    const model = createLanguageModel(ModelRefSchema.parse('gateway/key-test'), {
      apiKey: 'internal-token-must-not-be-a-bearer-key',
      providerId: 'gateway',
      modelName: 'ferry/auto-free',
      baseUrl: `${fake.baseUrl}/v1`,
      headers: { 'x-ferry-internal-token': 'internal-token-must-not-be-a-bearer-key' },
    });
    await streamText({ model, prompt: 'hello' }).text;
    expect(fake.requests[0]?.body).toMatchObject({ model: 'ferry/auto-free' });
    expect(fake.requests[0]?.headers['x-ferry-internal-token']).toBe(
      'internal-token-must-not-be-a-bearer-key',
    );
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
  }, 30_000);

  it('uses a configured Gemini base URL for API requests', async () => {
    let requestedUrl = '';
    const model = createLanguageModel(ModelRefSchema.parse('gemini/gemini-2.5-flash'), {
      apiKey: 'fake-key',
      baseUrl: 'https://gemini.example/v1beta',
      fetch: (input) => {
        requestedUrl =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    await streamText({ model, prompt: 'Hello' }).text;
    expect(requestedUrl).toContain('https://gemini.example/v1beta/');
  });

  it('streams through an OpenAI-compatible fake and reports tool-call output', async () => {
    const fake = new FakeOpenAIServer({
      responses: [
        {
          chunks: [
            {
              id: 'chatcmpl_fake',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_fake_1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'chatcmpl_fake',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ],
        },
      ],
    });
    servers.push(fake);
    await fake.start();
    const model = createLanguageModel(ModelRefSchema.parse('custom/fake-model'), {
      apiKey: 'fake-key',
      baseUrl: `${fake.baseUrl}/v1`,
    });
    const result = streamText({
      model,
      prompt: 'Read README',
      tools: {
        read_file: {
          description: 'Read a file',
          inputSchema: z.object({ path: z.string() }),
          execute: ({ path }: { path: string }) => Promise.resolve(`contents of ${path}`),
        },
      },
    });
    const parts = [];
    for await (const part of result.stream) parts.push(part);
    expect(parts.some((part) => part.type === 'tool-call')).toBe(true);
    expect(fake.requests[0]?.url).toContain('/v1/chat/completions');
  });

  it('sends instructions outside the SDK messages field and requests streaming usage', async () => {
    const fake = await new FakeOpenAIServer({
      responses: [
        {
          chunks: [
            {
              id: 'chatcmpl_usage',
              object: 'chat.completion.chunk',
              choices: [
                { index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null },
              ],
            },
            {
              id: 'chatcmpl_usage',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
            },
          ],
        },
      ],
    }).start();
    servers.push(fake);
    const result = await streamProviderChat({
      model: ModelRefSchema.parse('custom/fake-model'),
      apiKey: 'fake-key',
      baseUrl: `${fake.baseUrl}/v1`,
      system: 'OpenCode system instruction',
      messages: [{ role: 'user', content: 'Say pong' }],
    });
    expect(result).toMatchObject({ text: 'pong', inputTokens: 17, outputTokens: 5 });
    expect(fake.requests[0]?.body).toMatchObject({
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: 'OpenCode system instruction' }, { role: 'user' }],
    });
  }, 30_000);

  it('sends required OpenCode attribution and session headers', async () => {
    const fake = new FakeOpenAIServer();
    servers.push(fake);
    await fake.start();
    const model = createLanguageModel(ModelRefSchema.parse('opencode/zen-model'), {
      apiKey: 'fake-key',
      baseUrl: `${fake.baseUrl}/v1`,
      sessionId: 'ferry-session-123',
    });
    await streamText({ model, prompt: 'Hello' }).text;
    expect(fake.requests[0]?.headers['user-agent']).toMatch(/^Ferry\/0\.0\.0\b/);
    expect(fake.requests[0]?.headers['x-session-id']).toBe('ferry-session-123');
  });

  it('observes streaming and regular responses with rate headers only', async () => {
    const fake = new FakeProviderServer({
      responseHeaders: {
        'x-ratelimit-remaining-requests': '7',
        authorization: 'must-not-leak',
      },
    });
    servers.push(fake);
    await fake.start();
    const observations: RawCallObservation[] = [];
    const fetcher = createObservedFetch((value) => observations.push(value), {
      providerId: 'fake',
      model: 'm',
    });
    const response = await fetcher(`${fake.baseUrl}/regular`, {
      method: 'POST',
      body: '{"ok":true}',
    });
    await response.json();
    expect(observations[0]).toMatchObject({
      statusCode: 200,
      requestBytes: 11,
      rateLimitHeaders: { 'x-ratelimit-remaining-requests': '7' },
    });
    expect(JSON.stringify(observations)).not.toContain('must-not-leak');
    expect(RawCallObservationSchema.safeParse(observations[0]).success).toBe(true);
    const observation = observations[0];
    if (!observation) throw new Error('Expected a provider call observation.');
    const usage = mergeUsage(observation, { inputTokens: 12, outputTokens: 4 });
    expect(usage).toMatchObject({
      providerId: 'fake',
      modelRef: 'm',
      inputTokens: 12,
      outputTokens: 4,
      status: 'success',
    });
    expect(UsageRecordSchema.safeParse(usage).success).toBe(true);
  });
});

describe('provider probes', () => {
  it('returns a typed timeout when the configured probe deadline expires', async () => {
    const hang = (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch;
    const result = await probe('openai', 'fake-key', { fetch: hang, timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, errorKind: 'timeout' });
  });

  it('probes with a one-token completion and identifies invalid or rate-limited keys', async () => {
    const success = new FakeOpenAIServer();
    servers.push(success);
    await success.start();
    const ok = await probe('groq', 'fake-key', { baseUrl: `${success.baseUrl}/v1` });
    expect(ok).toMatchObject({ ok: true, keyValid: true, message: 'Key valid' });
    expect(ProbeResultSchema.safeParse(ok).success).toBe(true);
    expect(success.requests.at(-1)?.body).toMatchObject({ max_tokens: 64 });

    const invalid = new FakeOpenAIServer({
      responses: [
        {
          status: 401,
          body: { error: { message: 'invalid api key', type: 'authentication_error' } },
        },
      ],
    });
    servers.push(invalid);
    await invalid.start();
    const invalidResult = await probe('groq', 'bad-key', { baseUrl: `${invalid.baseUrl}/v1` });
    expect(invalidResult).toMatchObject({
      ok: false,
      keyValid: false,
      errorKind: 'auth',
      message: 'invalid api key',
    });
    expect(ProbeResultSchema.safeParse(invalidResult).success).toBe(true);

    const limited = new FakeOpenAIServer({
      responses: [
        {
          status: 429,
          headers: { 'retry-after': '781' },
          body: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } },
        },
      ],
    });
    servers.push(limited);
    await limited.start();
    const limitedResult = await probe('groq', 'fake-key', { baseUrl: `${limited.baseUrl}/v1` });
    expect(limitedResult).toMatchObject({
      ok: false,
      keyValid: true,
      errorKind: 'rate_limit',
      message: 'rate limit exceeded',
    });
  }, 30000);
});

describe('provider error mapping', () => {
  it.each([
    [{ statusCode: 401, message: 'unauthorized' }, 'auth'],
    [{ statusCode: 429, message: 'rate limited' }, 'rate_limit'],
    [{ statusCode: 429, message: 'daily quota exhausted' }, 'quota_exhausted'],
    [{ statusCode: 400, message: 'maximum context length exceeded' }, 'context_overflow'],
    [{ statusCode: 400, message: 'invalid parameter' }, 'request_scoped_client'],
    [{ statusCode: 503, message: 'unavailable' }, 'server'],
    [
      {
        name: 'AI_StreamProviderError',
        message: 'generic wrapper',
        cause: { statusCode: 503, message: 'unavailable' },
      },
      'server',
    ],
    [{ code: 'ECONNRESET', message: 'socket reset' }, 'network'],
    [{ code: 'ETIMEDOUT', message: 'timeout' }, 'timeout'],
  ] as const)('maps %o to %s', (error, kind) => {
    expect(mapProviderError(error).kind).toBe(kind);
  });

  it('unwraps AI SDK stream provider causes and preserves retryability', () => {
    expect(
      mapProviderError({
        name: 'AI_StreamProviderError',
        message: 'stream failed',
        cause: { statusCode: 503, message: 'upstream unavailable' },
      }),
    ).toMatchObject({ kind: 'server', retryable: true, message: 'upstream unavailable' });
    expect(
      mapProviderError({
        name: 'AI_StreamProviderError',
        message: 'stream failed',
        cause: { statusCode: 400, message: 'invalid request' },
      }),
    ).toMatchObject({ kind: 'request_scoped_client', retryable: false });
  });
});
