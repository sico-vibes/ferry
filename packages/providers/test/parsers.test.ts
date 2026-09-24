import { describe, expect, it } from 'vitest';
import {
  parseCerebrasRateLimits,
  parseGeminiQuota,
  parseGenericRateLimits,
  parseGroqRateLimits,
  parseOpenRouterKey,
} from '../src/index.js';

const now = new Date('2026-09-24T12:00:00.000Z');

describe('quota parsers', () => {
  it('parses Groq daily requests, per-minute tokens, and retry-after', () => {
    expect(
      parseGroqRateLimits(
        {
          'x-ratelimit-limit-requests': '1000',
          'x-ratelimit-remaining-requests': '900',
          'x-ratelimit-reset-requests': '3600',
          'x-ratelimit-limit-tokens': '8000',
          'x-ratelimit-remaining-tokens': '7000',
          'x-ratelimit-reset-tokens': '60',
          'retry-after': '120',
          authorization: 'never copy me',
        },
        now,
      ),
    ).toEqual([
      {
        windowId: 'requests-day',
        remaining: 900,
        limit: 1000,
        resetAt: '2026-09-24T13:00:00.000Z',
        confidence: 'exact',
      },
      {
        windowId: 'tokens-minute',
        remaining: 7000,
        limit: 8000,
        resetAt: '2026-09-24T12:01:00.000Z',
        confidence: 'exact',
      },
      {
        windowId: 'retry-after',
        remaining: null,
        limit: null,
        resetAt: '2026-09-24T12:02:00.000Z',
        confidence: 'exact',
      },
    ]);
  });

  it('parses OpenRouter key quotas and next UTC midnight', () => {
    expect(
      parseOpenRouterKey(
        { data: { limit_remaining: 2.5, free_model_daily_requests: { remaining: 42, limit: 50 } } },
        now,
      ),
    ).toEqual([
      { windowId: 'credits', remaining: 2.5, limit: null, resetAt: null, confidence: 'exact' },
      {
        windowId: 'free-model-requests-day',
        remaining: 42,
        limit: 50,
        resetAt: '2026-09-25T00:00:00.000Z',
        confidence: 'exact',
      },
    ]);
  });

  it('parses Gemini RESOURCE_EXHAUSTED retry details', () => {
    expect(
      parseGeminiQuota(
        {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaMetric: 'generate_content_free_tier_requests' }],
              },
            ],
          },
        },
        now,
      ),
    ).toEqual([
      {
        windowId: 'gemini:generate_content_free_tier_requests',
        remaining: 0,
        limit: null,
        resetAt: '2026-09-25T07:00:00.000Z',
        confidence: 'exact',
      },
      {
        windowId: 'gemini:retry-after',
        remaining: null,
        limit: null,
        resetAt: '2026-09-24T12:00:30.000Z',
        confidence: 'exact',
      },
    ]);
    expect(parseGeminiQuota({}, now, 200)).toEqual([]);
  });

  it('maps Cerebras header variants by request/token day/minute dimensions', () => {
    expect(
      parseCerebrasRateLimits(
        {
          'x-ratelimit-limit-requests-minute': '5',
          'x-ratelimit-remaining-requests-minute': '3',
          'x-ratelimit-reset-requests-minute': '60',
          'x-ratelimit-limit-tokens-day': '1000000',
          'x-ratelimit-remaining-tokens-day': '950000',
        },
        now,
      ),
    ).toEqual([
      {
        windowId: 'requests-minute',
        limit: 5,
        remaining: 3,
        resetAt: '2026-09-24T12:01:00.000Z',
        confidence: 'exact',
      },
      {
        windowId: 'tokens-day',
        limit: 1000000,
        remaining: 950000,
        resetAt: null,
        confidence: 'exact',
      },
    ]);
  });

  it('parses generic rate-limit heuristics without exposing auth headers', () => {
    expect(
      parseGenericRateLimits(
        { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '4', authorization: 'secret' },
        now,
      ),
    ).toEqual([
      { windowId: 'generic:default', limit: 10, remaining: 4, resetAt: null, confidence: 'exact' },
    ]);
  });
});
