import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { classifyProviderError, parseRetryAfter, ResilienceLedger } from '../src/resilience.js';
import { classifyRetryAction, retryDelayMs, shouldStopFallback } from '../src/index.js';

describe('routing resilience primitives', () => {
  it('classifies retry/stop defensively and computes bounded jittered backoff', () => {
    expect(classifyRetryAction({ status: 401, message: 'temporary outage' })).toBe('stop');
    expect(classifyRetryAction({ status: 503, message: 'invalid key' })).toBe('retry');
    expect(classifyRetryAction({ message: 'authentication failed' })).toBe('stop');
    expect(classifyRetryAction({ message: 'unclassified provider issue' })).toBe('retry');
    expect(retryDelayMs(2, 300, 1_000, () => 0)).toBe(500);
    expect(retryDelayMs(20, 300, 1_000, () => 1)).toBe(1_000);
    expect(
      shouldStopFallback({ pinnedModelRef: 'groq/model', attemptedModelRef: 'groq/model' }),
    ).toBe(true);
    expect(
      shouldStopFallback({
        attemptedModelRef: 'gemini/model',
        avoidTrainingProviders: true,
        providerDataUse: 'Requests may be used to improve products.',
      }),
    ).toBe(true);
    expect(
      shouldStopFallback({
        attemptedModelRef: 'cloudflare/model',
        avoidTrainingProviders: true,
        providerDataUse: 'Does not use customer content to train models.',
      }),
    ).toBe(false);
  });

  it('does not count transient failures toward strikes and resets state on success', () => {
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classifyProviderError({ status: 503 }), 'm/model', 'p', 1_000);
    expect(ledger.active('provider', 'p', 1_001)?.strikes).toBe(0);
    ledger.recordFailure(
      classifyProviderError({ status: 429, retryAfter: '30s' }),
      'm/model',
      'p',
      1_000,
    );
    ledger.recordFailure(
      classifyProviderError({ status: 429, retryAfter: '30s' }),
      'm/model',
      'p',
      2_000,
    );
    ledger.recordSuccess('key', 'p');
    expect(ledger.active('key', 'p', 2_001)).toBeUndefined();
  });

  it('distinguishes a short throttle from exhausted quota and honors reset hints', () => {
    expect(
      classifyProviderError({ status: 429, message: 'Quota exceeded', retryAfter: '5m' }),
    ).toMatchObject({ family: 'rate_limit', scope: 'key', retryAfterMs: 300_000 });
    expect(classifyProviderError({ status: 429, message: 'Quota exceeded' }).family).toBe(
      'quota_exhausted',
    );
    expect(parseRetryAfter('2h')).toBe(7_200_000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 0)).toBe(10_000);
    expect(
      classifyProviderError({
        status: 429,
        responseBody: JSON.stringify({
          error: { details: [{ '@type': 'google.rpc.RetryInfo', retryDelay: '12s' }] },
          message: 'RESOURCE_EXHAUSTED',
        }),
      }),
    ).toMatchObject({ family: 'rate_limit', retryAfterMs: 12_000 });
  });

  it('keeps client request failures out of cooldown state and scopes model churn narrowly', () => {
    const ledger = new ResilienceLedger();
    const malformed = classifyProviderError({ status: 400, message: 'unknown field' });
    expect(malformed).toMatchObject({ family: 'request_scoped_client', scope: 'none' });
    ledger.recordFailure(malformed, 'gemini/gemini-2.5-flash', 'gemini', 1_000);
    const missing = classifyProviderError({ status: 404, message: 'model not found' });
    ledger.recordFailure(missing, 'gemini/gemini-2.5-flash', 'gemini', 1_000);
    expect(ledger.active('model', 'gemini/gemini-2.5-flash', 2_000)?.scope).toBe('model');
    expect(ledger.active('provider', 'gemini', 2_000)).toBeUndefined();
  });

  it('classifies single-request 413 and TPM failures without charging quota or cooldown state', () => {
    const errors = [
      classifyProviderError({ status: 413, message: 'Request Entity Too Large' }),
      classifyProviderError({
        status: 400,
        responseBody: JSON.stringify({
          error: {
            message: 'Request too large: tokens per minute limit 8000, requested 24552',
          },
        }),
      }),
    ];
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'request_too_large', scope: 'none' }),
      ]),
    );
    const ledger = new ResilienceLedger();
    for (const error of errors)
      ledger.recordFailure(error, 'groq/openai/gpt-oss-20b', 'groq', 1000);
    expect(ledger.snapshot()).toEqual([]);
  });

  it('expires scope state, decays on success, and exposes the earliest reset for a half-open probe', () => {
    const ledger = new ResilienceLedger();
    ledger.recordFailure(classifyProviderError({ status: 503 }), 'p/a', 'p', 1_000);
    ledger.recordFailure(
      classifyProviderError({ status: 429, message: 'quota exceeded' }),
      'q/a',
      'q',
      1_000,
    );
    expect(ledger.earliest(1_001)?.key).toBe('p');
    ledger.recordSuccess('provider', 'p');
    expect(ledger.active('provider', 'p', 1_001)).toBeUndefined();
    expect(ledger.active('key', 'q', 999_999)).toBeUndefined();
  });

  it('never selects a model again while its model lockout is active across failure sequences', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 8, maxLength: 50 }),
        (ticks) => {
          const ledger = new ResilienceLedger();
          const refs = ['nvidia/model-a', 'openrouter/model-b', 'groq/model-c'];
          const expiryByRef = new Map<string, number>();
          let now = 1_000;
          for (const tick of ticks) {
            let available = ledger.availableModelRefs(refs, now);
            if (!available.length) {
              const earliest = ledger
                .snapshot()
                .filter((entry) => entry.scope === 'model' && Date.parse(entry.expiresAt) > now)
                .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0];
              if (!earliest) throw new Error('model failure must have an expiry');
              now = Date.parse(earliest.expiresAt);
              available = ledger.availableModelRefs(refs, now);
            }
            const ref = available[tick % available.length];
            if (!ref) throw new Error('at least one model should be unlocked');
            expect(now).toBeGreaterThanOrEqual(expiryByRef.get(ref) ?? 0);
            const failure = {
              ...classifyProviderError({ status: 503, message: 'model unavailable' }),
              scope: 'model' as const,
            };
            ledger.recordFailure(failure, ref, ref.split('/')[0] ?? 'unknown', now);
            const lockout = ledger.active('model', ref, now);
            if (!lockout) throw new Error('failed model lockout was not recorded');
            expiryByRef.set(ref, Date.parse(lockout.expiresAt));
            expect(ledger.availableModelRefs(refs, now)).not.toContain(ref);
            now += tick % 60_000;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
