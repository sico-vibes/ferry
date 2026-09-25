import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeOpenAIServer, type FakeResponse } from '@ferry/testkit';
import type { RawCallObservation } from '@ferry/shared';
import {
  createObservedFetch,
  mapProviderError,
  parseGeminiQuota,
  parseGenericRateLimits,
  parseGroqRateLimits,
  probe,
} from '../src/index.js';

const servers: FakeOpenAIServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startServer(responses: FakeResponse[] = []) {
  const server = await new FakeOpenAIServer({ responses }).start();
  servers.push(server);
  return server;
}

const NOW = new Date('2026-09-24T12:00:00.000Z');

describe('QA-w2 providers: probe never echoes the key', () => {
  it('keeps the key out of a 401 result even when the provider echoes it', async () => {
    const key = 'sk-ferry-qa-w2-401-echo-0123456789';
    const server = await startServer([
      { status: 401, body: { error: { message: `Incorrect API key provided: ${key}` } } },
    ]);
    const result = await probe('openai', key, { baseUrl: `${server.baseUrl}/v1` });
    expect(result.errorKind).toBe('auth');
    expect(result.keyValid).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key.slice(0, -4));
  }, 30_000);

  it('keeps the key out of a 403 result', async () => {
    const key = 'sk-ferry-qa-w2-403-echo-0123456789';
    const server = await startServer([
      { status: 403, body: { error: { message: `Forbidden key ${key}` } } },
    ]);
    const result = await probe('openai', key, { baseUrl: `${server.baseUrl}/v1` });
    expect(result.errorKind).toBe('forbidden');
    expect(JSON.stringify(result)).not.toContain(key.slice(0, -4));
  }, 30_000);

  it('keeps a Gemini-style key (auth in the query string) out of fetch errors and observations', async () => {
    const key = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
    const error = new Error(
      `request failed for https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    );
    const failingFetch = (() => Promise.reject(error)) as unknown as typeof globalThis.fetch;
    const observations: RawCallObservation[] = [];
    const observed = createObservedFetch(
      (observation) => observations.push(observation),
      { providerId: 'gemini' },
      failingFetch,
    );
    await expect(
      observed(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      ),
    ).rejects.toBe(error);
    const mapped = mapProviderError(error);
    expect(JSON.stringify(observations)).not.toContain(key);
    expect(mapped.message).not.toContain(key);
    expect(mapped.message).not.toContain(key.slice(0, -4));
  });

  it('only records allowlisted rate-limit headers, never authorization headers', async () => {
    const key = 'sk-ferry-qa-w2-header-0123456789';
    const server = await startServer([
      {
        status: 200,
        headers: { 'x-ratelimit-limit-requests': '10', 'retry-after': '30' },
      },
    ]);
    const observations: RawCallObservation[] = [];
    const observed = createObservedFetch((observation) => observations.push(observation), {
      providerId: 'openai',
      model: 'gpt-5.4',
    });
    await observed(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain(key);
    expect(observations[0]?.rateLimitHeaders).toEqual({
      'x-ratelimit-limit-requests': '10',
      'retry-after': '30',
    });
  }, 30_000);
});

describe('QA-w2 providers: error classification', () => {
  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [500, 'server'],
    [503, 'server'],
  ] as const)(
    'maps HTTP %i to %s',
    async (status, kind) => {
      const server = await startServer([{ status, body: { error: { message: 'nope' } } }]);
      const result = await probe('openai', 'sk-ferry-qa-w2-classify', {
        baseUrl: `${server.baseUrl}/v1`,
      });
      expect(result.errorKind).toBe(kind);
      expect(result.keyValid).toBe(kind !== 'auth');
    },
    30_000,
  );

  it('classifies 429 with retry-after as a rate limit and surfaces the delay', async () => {
    const server = await startServer([{ status: 429, headers: { 'retry-after': '30' } }]);
    const result = await probe('openai', 'sk-ferry-qa-w2-429-retry', {
      baseUrl: `${server.baseUrl}/v1`,
    });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('rate_limit');
    expect(result.keyValid).toBe(true);
  }, 30_000);

  it('classifies 429 without retry-after without inventing a delay', () => {
    const mapped = mapProviderError({ statusCode: 429, message: 'slow down' });
    expect(mapped.kind).toBe('rate_limit');
    expect(mapped.retryAfterMs).toBeNull();
  });
});

describe('QA-w2 providers: hostile responses settle without leaking', () => {
  it('settles a 200 response with a garbage body as a failed probe', async () => {
    const key = 'sk-ferry-qa-w2-garbage-0123456789';
    const server = await startServer([{ status: 200, body: 'this is not a completion payload' }]);
    const result = await probe('openai', key, { baseUrl: `${server.baseUrl}/v1` });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key.slice(0, -4));
  }, 30_000);

  it.fails(
    'fails fast on a hung provider instead of hanging forever',
    async () => {
      // BUG: probe()/generateText() has no AbortSignal or timeout, so a provider that
      // never responds leaves the RPC promise pending indefinitely. The client-side
      // RPC timeout hides this from callers but the core worker stays stuck.
      const hang = (() =>
        new Promise<Response>(() => undefined)) as unknown as typeof globalThis.fetch;
      const pending = probe('openai', 'sk-ferry-qa-w2-hang-0123456789', { fetch: hang }).then(
        () => 'settled' as const,
        () => 'settled' as const,
      );
      const outcome = await Promise.race([pending, delay(1_000).then(() => 'timeout' as const)]);
      await Promise.race([pending, delay(50)]);
      expect(outcome).toBe('settled');
    },
    10_000,
  );
});

describe('QA-w2 providers: quota parser hardening', () => {
  it('does not throw on an oversized all-digit Gemini retryDelay', () => {
    // BUG: parseGeminiQuota() builds a Date from retryDelay then calls toISOString()
    // without a validity guard, so a huge provider-controlled value throws
    // RangeError: Invalid time value.
    const body = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '99999999999999999999s',
          },
        ],
      },
    };
    expect(() => parseGeminiQuota(body, NOW, 429)).not.toThrow();
  });

  it('ignores negative and overflowing header values without emitting invalid windows', () => {
    const hostileHeaders: Record<string, string>[] = [
      {
        'x-ratelimit-limit-requests': '-5',
        'x-ratelimit-remaining-requests': '-1',
        'x-ratelimit-reset-requests': '-100',
        'retry-after': '-30',
      },
      {
        'x-ratelimit-limit-requests': '1e18',
        'x-ratelimit-remaining-requests': '1e18',
        'x-ratelimit-reset-requests': '99999999999999999999',
        'retry-after': '99999999999999999999',
      },
      {
        'x-ratelimit-limit-tokens': 'NaN',
        'x-ratelimit-remaining-tokens': 'Infinity',
        'x-ratelimit-reset-tokens': '',
      },
      { 'x-ratelimit-': '10', 'x-ratelimit--limit--requests': '3' },
    ];
    for (const headers of hostileHeaders) {
      const parsers = [parseGenericRateLimits, parseGroqRateLimits];
      for (const parse of parsers) {
        let windows: ReturnType<typeof parseGenericRateLimits> = [];
        expect(() => {
          windows = parse(headers, NOW);
        }).not.toThrow();
        for (const window of windows) {
          if (window.remaining !== null) expect(window.remaining).toBeGreaterThanOrEqual(0);
          if (window.limit !== null) expect(window.limit).toBeGreaterThanOrEqual(0);
          if (window.resetAt !== null) expect(Number.isNaN(Date.parse(window.resetAt))).toBe(false);
        }
      }
    }
  });

  it('never emits a NaN or negative window from arbitrary header text', () => {
    const samples: Record<string, string>[] = [
      { 'x-ratelimit-limit-requests': '10.5' },
      { 'x-ratelimit-remaining-requests': '0x10' },
      { 'x-ratelimit-reset-requests': 'Wed, 24 Sep 2026 12:00:45 GMT' },
      { 'retry-after': '0' },
    ];
    for (const sample of samples) {
      for (const parse of [parseGenericRateLimits, parseGroqRateLimits]) {
        for (const window of parse(sample, NOW)) {
          expect(Number.isFinite(window.remaining ?? 0)).toBe(true);
          expect(Number.isFinite(window.limit ?? 0)).toBe(true);
        }
      }
    }
  });
});
