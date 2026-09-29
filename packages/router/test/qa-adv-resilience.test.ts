import { describe, expect, it } from 'vitest';
import {
  ResilienceEntrySchema,
  ResilienceLedger,
  classifyProviderError,
  onStepError,
  parseRetryAfter,
  reorderByCapabilities,
  type ClassifiedProviderError,
  type ResilienceScope,
} from '../src/index.js';

function classified(
  family: ClassifiedProviderError['family'],
  scope: ResilienceScope,
  retryAfterMs: number | null = null,
): ClassifiedProviderError {
  return {
    family,
    status: null,
    retryAfterMs,
    message: 'fixture failure',
    scope,
    retryable: ['server', 'timeout', 'stream_failure', 'rate_limit', 'quota_exhausted'].includes(
      family,
    ),
  };
}

describe('QA adv: typed error classifier', () => {
  it('separates transient rate limits from quota windows', () => {
    expect(classifyProviderError({ status: 429, message: 'Too many requests' })).toMatchObject({
      family: 'rate_limit',
      scope: 'key',
    });
    expect(
      classifyProviderError({ status: 429, message: 'You exceeded your current quota' }),
    ).toMatchObject({ family: 'quota_exhausted', scope: 'key' });
    expect(classifyProviderError({ status: 429, message: 'Insufficient balance' }).family).toBe(
      'quota_exhausted',
    );
    expect(classifyProviderError({ status: 429, message: '请求超出配额' }).family).toBe(
      'quota_exhausted',
    );
  });

  it('classifies paid-required as a permanent model exclusion for this session', () => {
    expect(
      classifyProviderError({ status: 402, code: 'paid_required', message: 'paid_required' }),
    ).toMatchObject({ family: 'paid_required', scope: 'model', retryable: false });
    const ledger = new ResilienceLedger();
    const failure = classifyProviderError({
      status: 402,
      code: 'paid_required',
      message: 'paid_required',
    });
    ledger.recordFailure(failure, 'kilo/deepseek/deepseek-v4-pro', 'kilo', 1_000);
    expect(ledger.active('model', 'kilo/deepseek/deepseek-v4-pro', 1_000_000_000)).toMatchObject({
      permanentNonFree: true,
      lastFamily: 'paid_required',
    });
    expect(ledger.availableModelRefs(['kilo/deepseek/deepseek-v4-pro'], 1_000_000_000)).toEqual([]);
    expect(ResilienceEntrySchema.safeParse(ledger.snapshot()[0]).success).toBe(true);
  });
  it('lets a declared sub-hour window force the short rate-limit path', () => {
    const short = classifyProviderError({
      status: 429,
      message: 'Quota exceeded',
      responseBody: JSON.stringify({
        error: { message: 'Quota exceeded', details: [{ retryDelay: '30s' }] },
      }),
    });
    expect(short).toMatchObject({ family: 'rate_limit', retryAfterMs: 30_000 });
    const long = classifyProviderError({
      status: 429,
      message: 'Quota exceeded',
      responseBody: JSON.stringify({
        error: { message: 'Quota exceeded', details: [{ retryDelay: '7200s' }] },
      }),
    });
    expect(long.family).toBe('quota_exhausted');
    const header = classifyProviderError({
      status: 429,
      message: 'Too many requests',
      headers: new Headers({ 'retry-after': '7' }),
    });
    expect(header.retryAfterMs).toBe(7_000);
  });

  it('classifies each error family with the matching scope', () => {
    const cases: {
      input: Parameters<typeof classifyProviderError>[0];
      family: ClassifiedProviderError['family'];
      scope: ClassifiedProviderError['scope'];
    }[] = [
      { input: { status: 413 }, family: 'request_too_large', scope: 'none' },
      {
        input: { status: 404, message: 'model not found' },
        family: 'model_not_found',
        scope: 'model',
      },
      { input: { status: 410, message: 'gone' }, family: 'model_not_found', scope: 'model' },
      {
        input: { status: 400, message: 'tool calling is not supported' },
        family: 'tools_unsupported',
        scope: 'model',
      },
      {
        input: { status: 400, message: 'This model maximum context length is 8192 tokens' },
        family: 'context_overflow',
        scope: 'model',
      },
      {
        input: { status: 400, message: 'blocked by content policy' },
        family: 'content_filter',
        scope: 'none',
      },
      { input: { status: 401, message: 'invalid api key' }, family: 'auth', scope: 'none' },
      {
        input: { status: 403, message: 'free models only work inside opencode' },
        family: 'unsupported_free_tier',
        scope: 'none',
      },
      {
        input: { status: 400, message: 'bad field' },
        family: 'request_scoped_client',
        scope: 'none',
      },
      { input: { status: 504, message: 'gateway timeout' }, family: 'timeout', scope: 'provider' },
      { input: { status: 500, message: 'boom' }, family: 'server', scope: 'provider' },
      { input: { status: 502, message: 'bad gateway' }, family: 'server', scope: 'provider' },
      { input: { message: 'socket hang up' }, family: 'stream_failure', scope: 'provider' },
    ];
    for (const { input, family, scope } of cases) {
      const result = classifyProviderError(input);
      expect(result, JSON.stringify(input)).toMatchObject({ family, scope });
    }
  });

  it('BUG: HTTP 408 is classified as request_scoped_client instead of timeout', () => {
    // The generic 4xx branch (`status >= 400 && status < 500`) is evaluated
    // before the `status === 408` timeout branch, so a provider request
    // timeout gets scope 'none'. In the agent loop that means a 408 is
    // terminal (no fallback, no cooldown) instead of a provider timeout.
    const result = classifyProviderError({ status: 408, message: 'Request Timeout' });
    expect(result).toMatchObject({ family: 'timeout', scope: 'provider' });
  });

  it('parses numeric, relative, and HTTP-date Retry-After values', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(30)).toBe(30_000);
    expect(parseRetryAfter('5m')).toBe(300_000);
    expect(parseRetryAfter('2h')).toBe(7_200_000);
    expect(parseRetryAfter('1h30m')).toBe(5_400_000);
    expect(parseRetryAfter('1500ms')).toBe(1_500);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    const future = new Date(now + 10_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBeGreaterThan(8_000);
    expect(parseRetryAfter(future, now)).toBeLessThan(11_000);
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  it('BUG: a negative Retry-After is parsed as a historical date instead of rejected', () => {
    // `Date.parse('-5')` succeeds (as a year-ish value), so an invalid
    // Retry-After header becomes a bogus 0ms delay rather than null.
    expect(parseRetryAfter('-5')).toBeNull();
  });
});

describe('QA adv: resilience ledger', () => {
  const now = 1_000_000;

  it('escalates backoff and imposes a capped ten-minute ban on the third strike', () => {
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classified('rate_limit', 'provider'), 'm', 'p', now);
    expect(Date.parse(ledger.active('provider', 'p', now)?.expiresAt ?? '')).toBe(now + 5_000);
    ledger.recordFailure(classified('rate_limit', 'provider'), 'm', 'p', now + 1);
    expect(Date.parse(ledger.active('provider', 'p', now + 2)?.expiresAt ?? '')).toBe(
      now + 1 + 10_000,
    );
    ledger.recordFailure(classified('rate_limit', 'provider'), 'm', 'p', now + 2);
    expect(ledger.active('provider', 'p', now + 3)).toMatchObject({ strikes: 3, failures: 3 });
    expect(Date.parse(ledger.active('provider', 'p', now + 3)?.expiresAt ?? '')).toBe(
      now + 2 + 600_000,
    );
  });

  it('resets strikes after the strike window passes', () => {
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classified('rate_limit', 'provider'), 'm', 'p', now);
    ledger.recordFailure(classified('rate_limit', 'provider'), 'm', 'p', now + 1);
    ledger.recordFailure(classified('rate_limit', 'provider'), 'm', 'p', now + 2);
    ledger.recordFailure(classified('rate_limit', 'provider'), 'm', 'p', now + 11 * 60_000);
    expect(ledger.active('provider', 'p', now + 11 * 60_000 + 1)?.strikes).toBe(1);
  });

  it('honours retry-after hints and clamps model-scope cooldowns to one minute', () => {
    const hinted = new ResilienceLedger();
    hinted.recordFailure(classified('rate_limit', 'provider', 2_000), 'm', 'p', now);
    expect(Date.parse(hinted.active('provider', 'p', now)?.expiresAt ?? '')).toBe(now + 2_000);

    const model = new ResilienceLedger();
    model.recordFailure(classified('rate_limit', 'model', 2_000), 'm', 'p', now);
    expect(Date.parse(model.active('model', 'm', now)?.expiresAt ?? '')).toBe(now + 60_000);
  });

  it('excludes cooling models until expiry and reports the earliest reset', () => {
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classified('model_not_found', 'model'), 'a', 'p', now);
    ledger.recordFailure(classified('server', 'provider'), 'b', 'q', now);
    expect(ledger.availableModelRefs(['a', 'b'], now)).toEqual(['b']);
    expect(ledger.availableModelRefs(['a', 'b'], now + 60_001)).toEqual(['a', 'b']);
    expect(ledger.earliest(now)?.key).toBe('q');

    const fresh = new ResilienceLedger();
    fresh.recordFailure(classified('model_not_found', 'model'), 'a', 'p', now);
    fresh.recordFailure(classified('server', 'provider'), 'b', 'q', now);
    expect(fresh.earliest(now)?.key).toBe('q');
    expect(fresh.earliest(now + 5_001)?.key).toBe('a');
    expect(fresh.earliest(now + 60_001)).toBeUndefined();
  });

  it('drops the active cooldown on success', () => {
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classified('server', 'provider'), 'm', 'p', now);
    ledger.recordFailure(classified('server', 'provider'), 'm', 'p', now + 1);
    ledger.recordFailure(classified('server', 'provider'), 'm', 'p', now + 2);
    ledger.recordSuccess('provider', 'p');
    expect(ledger.snapshot().find((entry) => entry.key === 'p')?.failures).toBe(1);
    expect(ledger.active('provider', 'p', now + 3)).toBeUndefined();
  });

  it('BUG: a success erases the halved failure count before it can be used', () => {
    // `recordSuccess` halves failures (2 -> 1) but stamps expiresAt at the
    // epoch; the next `active()` read deletes the entry, so the retained
    // failure is lost and the following failure is counted as a first strike.
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classified('server', 'provider'), 'm', 'p', now);
    ledger.recordFailure(classified('server', 'provider'), 'm', 'p', now + 1);
    ledger.recordSuccess('provider', 'p');
    ledger.recordFailure(classified('server', 'provider'), 'm', 'p', now + 10);
    expect(ledger.active('provider', 'p', now + 11)?.failures).toBe(2);
  });

  it('round-trips through the persisted schema', () => {
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classified('model_not_found', 'model'), 'a', 'p', now);
    const snapshot = ledger.snapshot();
    for (const entry of snapshot) expect(() => ResilienceEntrySchema.parse(entry)).not.toThrow();
    const restored = new ResilienceLedger(snapshot);
    expect(restored.active('model', 'a', now)?.failures).toBe(1);
  });
});

describe('QA adv: capability reordering and retry policy', () => {
  it('floats tool-capable models to the front only when tools are required', () => {
    const models = [
      { name: 'a', toolCalling: false },
      { name: 'b', toolCalling: true },
      { name: 'c', toolCalling: false },
    ];
    expect(reorderByCapabilities(models, true).map((model) => model.name)).toEqual(['b', 'a', 'c']);
    expect(reorderByCapabilities(models, false).map((model) => model.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('retries the same model only for short explicit rate-limit delays', () => {
    expect(onStepError({ kind: 'rate_limit', retryAfterSeconds: 0 })).toEqual({
      action: 'retry_same',
      attempts: 1,
    });
    expect(onStepError({ kind: 'rate_limit', retryAfterSeconds: 10 }).action).toBe('retry_same');
    expect(onStepError({ kind: 'rate_limit', retryAfterSeconds: 10.5 }).action).toBe('reselect');
    expect(onStepError({ kind: 'quota_exhausted', retryAfterSeconds: 1 }).action).toBe('reselect');
    expect(onStepError({ kind: 'timeout' }).action).toBe('reselect');
  });
});
