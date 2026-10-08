import { describe, expect, it } from 'vitest';
import { ProviderHealthTracker } from '../src/health.js';

describe('provider health scopes', () => {
  it.each([408, 500, 502, 503, 504, 599])(
    'opens for HTTP %i, grants one timed probe, and closes on success',
    (status) => {
      let now = 0;
      const states: string[] = [];
      const health = new ProviderHealthTracker({
        now: () => now,
        onChange: (snapshot) => states.push(snapshot.breaker),
      });
      health.record({ providerId: 'openai', status, success: false });
      expect(health.available('openai')).toBe(false);
      expect(health.beginProbe('openai')).toBe(false);
      now = 60_000;
      expect(health.beginProbe('openai')).toBe(true);
      expect(health.beginProbe('openai')).toBe(false);
      expect(health.available('openai')).toBe(false);
      health.record({ providerId: 'openai', success: true, latencyMs: 80 });
      expect(health.available('openai')).toBe(true);
      expect(states).toEqual(['open', 'half_open', 'closed']);
    },
  );
  it.each([400, 401, 403, 404, 422, 429])('does not open for HTTP %i', (status) => {
    const health = new ProviderHealthTracker();
    health.record({ providerId: 'openai', status, success: false });
    expect(health.snapshot('openai').breaker).toBe('closed');
  });
  it('opens on network timeouts with a configurable retry delay and reopens a failed probe', () => {
    let now = 0;
    const health = new ProviderHealthTracker({ now: () => now, probeAfterMs: 2000 });
    health.record({ providerId: 'openai', success: false, message: 'network timeout' });
    now = 2000;
    expect(health.beginProbe('openai')).toBe(true);
    health.record({ providerId: 'openai', status: 503, success: false });
    expect(health.snapshot('openai').nextProbeAt).toBe(new Date(4000).toISOString());
  });
  it.each(['30', 'Thu, 01 Jan 1970 00:00:30 GMT'])(
    'cools only the failed key using Retry-After %s',
    (retryAfter) => {
      let now = 0;
      const health = new ProviderHealthTracker({ now: () => now });
      health.record({ providerId: 'openai', keyId: '1', status: 429, retryAfter, success: false });
      expect(health.available('openai', 'openai/a', '1')).toBe(false);
      expect(health.available('openai', 'openai/a', '2')).toBe(true);
      health.record({ providerId: 'openai', keyId: '2', success: true });
      expect(health.available('openai', 'openai/a', '1')).toBe(false);
      now = 30_000;
      expect(health.available('openai', 'openai/a', '1')).toBe(true);
    },
  );
  it.each([
    [404, 'not found'],
    [400, 'model not supported'],
    [400, 'model_not_found'],
  ])('locks only the failed model and clears locks on discovery', (status, message) => {
    const health = new ProviderHealthTracker();
    health.record({
      providerId: 'openai',
      modelRef: 'openai/gone',
      status,
      message,
      success: false,
    });
    expect(health.available('openai', 'openai/gone')).toBe(false);
    expect(health.available('openai', 'openai/other')).toBe(true);
    health.discovered('openai');
    expect(health.available('openai', 'openai/gone')).toBe(true);
  });
  it('reports hourly percentiles and success rate without stale observations', () => {
    let now = 0;
    const health = new ProviderHealthTracker({ now: () => now });
    for (const latencyMs of [10, 20, 30, 40])
      health.record({ providerId: 'openai', latencyMs, success: true });
    health.record({ providerId: 'openai', status: 401, success: false });
    expect(health.snapshot('openai')).toMatchObject({
      latencyP50Ms: 20,
      latencyP95Ms: 40,
      successRate1h: 0.8,
    });
    now = 3_600_000;
    expect(health.snapshot('openai')).toMatchObject({
      latencyP50Ms: null,
      latencyP95Ms: null,
      successRate1h: null,
    });
  });
});
