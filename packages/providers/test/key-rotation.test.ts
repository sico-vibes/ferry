import { describe, expect, it } from 'vitest';
import {
  autoDisableUntil,
  keyProbeReenabled,
  ProviderKeyRotation,
  type RotatingProviderKey,
} from '../src/key-rotation.js';

const key = (id: string, order: number, values: Partial<RotatingProviderKey> = {}) => ({
  id,
  order,
  enabled: true,
  status: 'ok' as const,
  cooldownUntil: null,
  ...values,
});

describe('provider key rotation', () => {
  it('rotates in configured order and skips a key in cooldown', () => {
    const pool = new ProviderKeyRotation();
    const keys = [
      key('first', 0, { status: 'rate_limited', cooldownUntil: '2030-01-01T00:00:00.000Z' }),
      key('second', 1),
      key('third', 2),
    ];
    const now = new Date('2029-01-01T00:00:00.000Z');
    expect(pool.select('p', keys, now)?.id).toBe('second');
    expect(pool.select('p', keys, now)?.id).toBe('third');
    expect(pool.select('p', keys, now)?.id).toBe('second');
  });

  it('reports a provider key pool unavailable only when every key is unavailable', () => {
    const pool = new ProviderKeyRotation();
    expect(pool.select('p', [key('a', 0, { enabled: false }), key('b', 1)])?.id).toBe('b');
    expect(
      pool.select('p', [key('a', 0, { status: 'invalid' }), key('b', 1, { enabled: false })]),
    ).toBeUndefined();
  });

  it('selects by weight and applies temporary disable and successful probe recovery rules', () => {
    const pool = new ProviderKeyRotation(() => 0.8);
    expect(
      pool.select(
        'p',
        [key('small', 0, { weight: 1 }), key('large', 1, { weight: 4 })],
        new Date(),
        'weighted',
      )?.id,
    ).toBe('large');
    const current = { statusCode: 503, message: 'temporary outage', at: 1000 };
    const until = autoDisableUntil([{ statusCode: 500, message: 'failed', at: 900 }], current, {
      statusCodes: [503],
      keywords: [],
      failureCount: 5,
      windowMs: 60_000,
      disableForMs: 30_000,
    });
    expect(until).toBe(31_000);
    expect(keyProbeReenabled(until, true)).toBe(true);
    expect(keyProbeReenabled(until, false)).toBe(false);
  });
});
