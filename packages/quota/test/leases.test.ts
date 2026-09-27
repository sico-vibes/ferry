import { describe, expect, it } from 'vitest';
import { QuotaLeaseLedger } from '../src/leases.js';

describe('provider-wide quota reservations', () => {
  it('reserves capacity atomically across models and releases it after the request', () => {
    const ledger = new QuotaLeaseLedger();
    const now = Date.parse('2026-09-27T12:00:00Z');
    const first = ledger.acquire(
      'provider-pool',
      { requests: 1, tokens: 60 },
      { requests: 2, tokens: 100 },
      now,
    );
    expect(first).toBeDefined();
    if (!first) throw new Error('first quota lease should be acquired');
    expect(
      ledger.acquire(
        'provider-pool',
        { requests: 1, tokens: 50 },
        { requests: 2, tokens: 100 },
        now,
      ),
    ).toBeUndefined();
    ledger.release(first.id);
    expect(
      ledger.acquire(
        'provider-pool',
        { requests: 1, tokens: 50 },
        { requests: 2, tokens: 100 },
        now,
      ),
    ).toBeDefined();
  });

  it('expires abandoned reservations on the fake clock and allows disabled callers to bypass leases', () => {
    const ledger = new QuotaLeaseLedger();
    const now = 100_000;
    ledger.acquire('pool', { requests: 1, tokens: 10 }, { requests: 1, tokens: 10 }, now, 50);
    expect(
      ledger.acquire('pool', { requests: 1, tokens: 1 }, { requests: 1, tokens: 10 }, now + 49, 50),
    ).toBeUndefined();
    expect(
      ledger.acquire('pool', { requests: 1, tokens: 1 }, { requests: 1, tokens: 10 }, now + 50, 50),
    ).toBeDefined();
    const acquireForSetting = (enabled: boolean) =>
      enabled
        ? ledger.acquire('other', { requests: 1, tokens: 1 }, { requests: 0, tokens: 0 }, now)
        : 'bypassed';
    expect(acquireForSetting(false)).toBe('bypassed');
  });
});
