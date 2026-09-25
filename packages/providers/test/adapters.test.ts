import { afterEach, describe, expect, it } from 'vitest';
import { streamText } from 'ai';
import { z } from 'zod';
import {
  ModelRefSchema,
  ProbeResultSchema,
  RawCallObservationSchema,
  UsageRecordSchema,
  type RawCallObservation,
} from '@ferry/shared';
import { FakeOpenAIServer, FakeProviderServer } from '@ferry/testkit';
import {
  createLanguageModel,
  createObservedFetch,
  mapProviderError,
  mergeUsage,
  probe,
} from '../src/index.js';

const servers: FakeProviderServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('provider adapters', () => {
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
  it('probes with a one-token completion and identifies invalid or rate-limited keys', async () => {
    const success = new FakeOpenAIServer();
    servers.push(success);
    await success.start();
    const ok = await probe('groq', 'fake-key', { baseUrl: `${success.baseUrl}/v1` });
    expect(ok).toMatchObject({ ok: true, keyValid: true, message: 'Key valid' });
    expect(ProbeResultSchema.safeParse(ok).success).toBe(true);
    expect(success.requests[0]?.body).toMatchObject({ max_tokens: 1 });

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
      message: 'Key invalid',
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
      message: 'Rate limited — resets in 0h 14m',
    });
  }, 30000);
});

describe('provider error mapping', () => {
  it.each([
    [{ statusCode: 401, message: 'unauthorized' }, 'auth'],
    [{ statusCode: 429, message: 'rate limited' }, 'rate_limit'],
    [{ statusCode: 429, message: 'daily quota exhausted' }, 'quota_exhausted'],
    [{ statusCode: 400, message: 'maximum context length exceeded' }, 'context_overflow'],
    [{ statusCode: 400, message: 'invalid parameter' }, 'bad_request'],
    [{ statusCode: 503, message: 'unavailable' }, 'server'],
    [{ code: 'ECONNRESET', message: 'socket reset' }, 'network'],
    [{ code: 'ETIMEDOUT', message: 'timeout' }, 'timeout'],
  ] as const)('maps %o to %s', (error, kind) => {
    expect(mapProviderError(error).kind).toBe(kind);
  });
});
