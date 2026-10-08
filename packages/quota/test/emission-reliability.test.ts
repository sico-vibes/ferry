import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuotaEngine } from '../src/engine.js';
import { ProviderIdSchema, ModelInfoSchema } from '@ferry/shared';

const groq = {
  provider: 'groq',
  name: 'Groq',
  tag: 'legit' as const,
  signup_url: null,
  docs_url: null,
  terms_note: '',
  data_use: '',
  verified_at: '2026-10-08',
  source_url: 'https://example.invalid',
  windows: [
    {
      scope: 'provider' as const,
      metric: 'requests' as const,
      kind: 'rolling' as const,
      length: 60,
      limit: 100,
    },
  ],
};
let engine: QuotaEngine | undefined;
afterEach(() => {
  engine?.dispose();
  vi.useRealTimers();
});
describe('meaningful quota updates', () => {
  it('honors an early authoritative reset and retains its known limit', () => {
    let now = Date.parse('2026-10-08T12:00:00Z');
    engine = new QuotaEngine({
      catalog: { providers: [groq], models: [] },
      now: () => new Date(now),
    });
    engine.recordUsage({
      id: 'old',
      providerId: ProviderIdSchema.parse('groq'),
      modelRef: 'groq/owner',
      occurredAt: new Date(now).toISOString(),
      status: 'success',
    });
    const windowId = engine.getWindows('groq')[0]?.id ?? '';
    engine.observe({
      id: 'header',
      providerId: ProviderIdSchema.parse('groq'),
      windowId,
      metric: 'requests',
      limit: 10,
      remaining: 0,
      source: 'header',
      observedAt: new Date(now).toISOString(),
      resetAt: new Date(now + 12000).toISOString(),
    });
    now += 12000;
    expect(engine.getWindows('groq')[0]).toMatchObject({ used: 0, limit: 10, remaining: 10 });
    engine.recordUsage({
      id: 'new',
      providerId: ProviderIdSchema.parse('groq'),
      modelRef: 'groq/owner',
      occurredAt: new Date(now).toISOString(),
      status: 'success',
    });
    expect(engine.getWindows('groq')[0]).toMatchObject({ used: 1, limit: 10, remaining: 9 });
  });
  it('keeps capacity available when another routable model pool still has headroom', () => {
    const first = ModelInfoSchema.parse({
      ref: 'groq/first',
      providerId: 'groq',
      name: 'First',
      tier: 'T3',
      contextWindow: 128000,
      maxOutput: 8192,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    });
    const second = ModelInfoSchema.parse({ ...first, ref: 'groq/second', name: 'Second' });
    const pools = {
      ...groq,
      windows: ['first', 'second'].map((model) => ({
        scope: 'model' as const,
        model,
        metric: 'requests' as const,
        kind: 'fixed_daily' as const,
        tz: 'UTC',
        time: '00:00',
        limit: 100,
      })),
    };
    let onlyFirst = false;
    engine = new QuotaEngine({
      catalog: { providers: [pools], models: [first, second] },
      eligibleModelRefs: () => (onlyFirst ? [first.ref] : [first.ref, second.ref]),
    });
    engine.observe({
      id: 'empty',
      providerId: first.providerId,
      modelRef: first.ref,
      windowId: engine.getWindows('groq').find((window) => window.modelRef === first.ref)?.id ?? '',
      metric: 'requests',
      remaining: 0,
      limit: 100,
      source: 'header',
      observedAt: new Date().toISOString(),
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(engine.capacitySummary().lowCapacity).toBe(false);
    expect(engine.stepsLeft('groq')).toBe(100);
    onlyFirst = true;
    expect(engine.capacitySummary().lowCapacity).toBe(true);
    expect(engine.capacitySummary().perProvider[0]?.stepsLeft).toBe(0);
  });
  it('frees a rolling request slot exactly at its reset time', () => {
    let now = Date.parse('2026-10-08T12:00:00Z');
    engine = new QuotaEngine({
      catalog: { providers: [groq], models: [] },
      now: () => new Date(now),
    });
    engine.recordUsage({
      id: 'request',
      providerId: ProviderIdSchema.parse('groq'),
      modelRef: 'groq/owner',
      occurredAt: new Date(now).toISOString(),
      status: 'success',
    });
    now += 59_999;
    expect(engine.getWindows('groq')[0]?.used).toBe(1);
    now++;
    expect(engine.getWindows('groq')[0]?.used).toBe(0);
  });
  it('emits once per usage/refill and never for rolling reset drift over 60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const emit = vi.fn();
    engine = new QuotaEngine({ catalog: { providers: [groq], models: [] }, emit });
    engine.recordUsage({
      id: 'request',
      providerId: ProviderIdSchema.parse('groq'),
      modelRef: 'groq/owner',
      occurredAt: new Date().toISOString(),
      status: 'success',
      inputTokens: 100,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(emit).toHaveBeenCalledTimes(1);
    for (let seconds = 0; seconds < 59; seconds++) {
      // Repeated identical observations exercise deduplication even when callers schedule emits.
      engine.recordUsage({
        id: 'request',
        providerId: ProviderIdSchema.parse('groq'),
        modelRef: 'groq/owner',
        occurredAt: '2026-10-08T12:00:00.000Z',
        status: 'success',
        inputTokens: 100,
      });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(engine.capacitySummary().perProvider[0]?.percent).toBe(100);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('does not call aggregate capacity low when one of nine providers is exhausted', () => {
    const providers = Array.from({ length: 9 }, (_, index) => ({
      ...groq,
      provider: `provider${String(index)}`,
    }));
    engine = new QuotaEngine({ catalog: { providers, models: [] } });
    engine.observe({
      id: 'empty',
      providerId: ProviderIdSchema.parse('provider0'),
      windowId: 'provider:requests:rolling:60',
      metric: 'requests',
      remaining: 0,
      limit: 100,
      source: 'header',
      period: 'minute',
      observedAt: new Date().toISOString(),
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(engine.capacitySummary().lowCapacity).toBe(false);
    const scoped = new QuotaEngine({
      catalog: { providers, models: [] },
      eligibleProviders: () => ['provider0'],
    });
    try {
      scoped.observe({
        id: 'empty',
        providerId: ProviderIdSchema.parse('provider0'),
        windowId: scoped.getWindows('provider0')[0]?.id ?? '',
        metric: 'requests',
        remaining: 0,
        limit: 100,
        source: 'header',
        period: 'minute',
        observedAt: new Date().toISOString(),
        resetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(scoped.capacitySummary().lowCapacity).toBe(true);
    } finally {
      scoped.dispose();
    }
  });
});
