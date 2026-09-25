import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { streamText } from 'ai';
import { z } from 'zod';
import { ModelRefSchema, ProviderIdSchema } from '@ferry/shared';
import {
  createLanguageModel,
  mapProviderError,
  mergeUsage,
  parseCerebrasRateLimits,
  parseGeminiQuota,
  parseGenericRateLimits,
  parseGroqRateLimits,
  parseOpenRouterKey,
  parseQuota,
  type ParsedQuotaWindow,
} from '../src/index.js';

const now = new Date('2026-09-24T12:00:00.000Z');

function assertWindows(windows: ParsedQuotaWindow[]): void {
  for (const window of windows) {
    expect(typeof window.windowId).toBe('string');
    if (window.remaining !== null) expect(window.remaining).toBeGreaterThanOrEqual(0);
    if (window.limit !== null) expect(window.limit).toBeGreaterThanOrEqual(0);
    if (window.resetAt !== null) expect(Number.isNaN(Date.parse(window.resetAt))).toBe(false);
  }
}

describe('QA providers: quota parser robustness', () => {
  it('never throws and always returns non-negative windows for arbitrary header records', () => {
    const headerRecord = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.string({ maxLength: 6 }),
      { maxKeys: 8 },
    );
    fc.assert(
      fc.property(headerRecord, (headers) => {
        for (const parser of [
          parseGenericRateLimits,
          parseGroqRateLimits,
          parseCerebrasRateLimits,
        ]) {
          assertWindows(parser(headers, now));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never throws for arbitrary Gemini/OpenRouter/error bodies', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        assertWindows(parseGeminiQuota(body, now, 429));
        assertWindows(parseOpenRouterKey(body, now));
        const mapped = mapProviderError(body);
        expect(typeof mapped.kind).toBe('string');
        expect(mapped.retryAfterMs === null || mapped.retryAfterMs >= 0).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('is case-insensitive for rate-limit headers', () => {
    expect(
      parseGroqRateLimits({
        'X-RateLimit-Limit-Requests': '10',
        'X-RATELIMIT-REMAINING-REQUESTS': '4',
      }),
    ).toContainEqual({
      windowId: 'requests-day',
      remaining: 4,
      limit: 10,
      resetAt: null,
      confidence: 'exact',
    });
  });

  it('ignores malformed numeric headers instead of producing NaN windows', () => {
    assertWindows(
      parseGenericRateLimits(
        {
          'x-ratelimit-limit-requests': 'not-a-number',
          'x-ratelimit-remaining-requests': '-5',
          'x-ratelimit-reset-requests': 'NaN',
        },
        now,
      ),
    );
    expect(parseGenericRateLimits({ 'x-ratelimit-limit-requests': '-5' }, now)).toEqual([]);
  });

  it('parses a 429 without retry-after as a plain rate limit', () => {
    const mapped = mapProviderError({ statusCode: 429, message: 'slow down' });
    expect(mapped.kind).toBe('rate_limit');
    expect(mapped.retryAfterMs).toBeNull();
  });

  it('parses retry-after as seconds, HTTP date, and rejects garbage', () => {
    expect(
      parseGenericRateLimits({ 'retry-after': '30' }, now).find((w) => w.windowId === 'retry-after')
        ?.resetAt,
    ).toBe('2026-09-24T12:00:30.000Z');
    expect(
      parseGenericRateLimits({ 'retry-after': 'Wed, 24 Sep 2026 12:00:45 GMT' }, now).find(
        (w) => w.windowId === 'retry-after',
      )?.resetAt,
    ).toBe('2026-09-24T12:00:45.000Z');
  });

  it.each([null, undefined, '', 'not-a-parser', 'gemini_retry_info'])(
    'parseQuota tolerates parser id %s',
    (parserId) => {
      expect(() => parseQuota(parserId, { headers: {}, body: {}, status: 429, now })).not.toThrow();
    },
  );

  it('only emits Gemini quota windows for HTTP 429', () => {
    const body = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
      },
    };
    expect(parseGeminiQuota(body, now, 200)).toEqual([]);
    expect(parseGeminiQuota(body, now, 429).length).toBeGreaterThan(0);
  });

  it('skips a default limit that is mixed with a dimensioned header', () => {
    // BUG: dimension detection drops the un-dimensioned "x-ratelimit-limit"
    // whenever any dimensioned header exists, so the limit is silently lost.
    const windows = parseGenericRateLimits(
      { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining-tokens': '5' },
      now,
    );
    expect(windows.some((window) => window.limit === 100)).toBe(true);
  });

  it('does not crash on an enormous retry-after value', () => {
    // BUG: the retry-after branches build a Date then call toISOString without a
    // validity guard, so a huge (provider- or attacker-controlled) value throws
    // RangeError: Invalid time value.
    expect(() => parseGenericRateLimits({ 'retry-after': '1e18' }, now)).not.toThrow();
    expect(() => parseGroqRateLimits({ 'retry-after': '99999999999999999999' }, now)).not.toThrow();
  });
});

describe('QA providers: usage mapping', () => {
  it('merges provider usage details without inventing values', () => {
    const observation = {
      providerId: ProviderIdSchema.parse('groq'),
      modelRef: 'groq/llama',
      startedAt: now.getTime(),
      latencyMs: 12,
      statusCode: 200,
      requestBytes: 10,
      rateLimitHeaders: {},
      errorKind: null,
    };
    expect(mergeUsage(observation, {})).not.toHaveProperty('inputTokens');
    expect(mergeUsage(observation, { inputTokens: 0 }).inputTokens).toBe(0);
    const details = mergeUsage(observation, {
      inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
      outputTokenDetails: { reasoningTokens: 2 },
    });
    expect(details.cachedTokens).toBe(7);
    expect(details.reasoningTokens).toBe(2);
    expect(details.status).toBe('success');
  });
});

interface RawServer {
  url: string;
  stop: () => Promise<void>;
}
const rawServers: RawServer[] = [];
afterEach(async () => {
  await Promise.all(rawServers.splice(0).map((server) => server.stop()));
});

async function startSseServer(
  events: string[],
  options: { done?: boolean; status?: number } = {},
): Promise<RawServer> {
  const server = createServer((_req, res: ServerResponse) => {
    res.writeHead(options.status ?? 200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(event);
    if (options.done !== false) res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const handle: RawServer = {
    url: `http://127.0.0.1:${String(address.port)}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
  rawServers.push(handle);
  return handle;
}

const chunk = (delta: unknown, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

describe('QA providers: streaming robustness', () => {
  it('reassembles a tool call whose JSON arguments are split across SSE chunks', async () => {
    const server = await startSseServer([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"REA' },
          },
        ],
      }),
      chunk(
        {
          tool_calls: [{ index: 0, function: { arguments: 'DME.md"}' } }],
        },
        'tool_calls',
      ),
    ]);
    const model = createLanguageModel(ModelRefSchema.parse('custom/fake'), {
      apiKey: 'k',
      baseUrl: `${server.url}/v1`,
    });
    const result = streamText({
      model,
      prompt: 'read',
      tools: {
        read_file: {
          description: 'read',
          inputSchema: z.object({ path: z.string() }),
        },
      },
    });
    let toolInput: unknown;
    for await (const part of result.stream) if (part.type === 'tool-call') toolInput = part.input;
    expect(toolInput).toEqual({ path: 'README.md' });
  }, 30_000);

  it('ignores SSE keepalive comments and tolerates a missing [DONE] sentinel', async () => {
    const server = await startSseServer([': keepalive\n\n', chunk({ content: 'ok' }, 'stop')], {
      done: false,
    });
    const model = createLanguageModel(ModelRefSchema.parse('custom/fake'), {
      apiKey: 'k',
      baseUrl: `${server.url}/v1`,
    });
    const text = await streamText({ model, prompt: 'hi' }).text;
    expect(text).toBe('ok');
  }, 30_000);

  it('does not hang on a garbage SSE data line followed by a valid one', async () => {
    const server = await startSseServer([
      'data: {this is not json}\n\n',
      chunk({ content: 'survived' }, 'stop'),
    ]);
    const model = createLanguageModel(ModelRefSchema.parse('custom/fake'), {
      apiKey: 'k',
      baseUrl: `${server.url}/v1`,
    });
    const result = streamText({ model, prompt: 'hi' });
    const streamed = new Promise<'resolved' | 'rejected'>((resolve) => {
      void result.text.then(
        () => {
          resolve('resolved');
        },
        () => {
          resolve('rejected');
        },
      );
    });
    const outcome = await Promise.race<'resolved' | 'rejected' | 'timeout'>([
      streamed,
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => {
          resolve('timeout');
        }, 5_000),
      ),
    ]);
    expect(outcome).not.toBe('timeout');
  }, 30_000);
});
