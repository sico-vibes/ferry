import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CapacitySummarySchema,
  ModelRefSchema,
  ProviderIdSchema,
  type ModelInfo,
  type UsageRecord,
} from '@ferry/shared';
import { QuotaEngine } from '../src/engine.js';
import { nextReset, remaining, usageIn, windowStart } from '../src/windows.js';

const PT = 'America/Los_Angeles';
const record = (occurredAt: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  id: occurredAt,
  providerId: 'gemini' as UsageRecord['providerId'],
  modelRef: 'google/gemini-flash',
  occurredAt,
  status: 'success',
  inputTokens: 1,
  outputTokens: 1,
  ...extra,
});

describe('QA quota: window boundaries and DST', () => {
  it('treats the window as half-open at exact boundaries', () => {
    const usage = usageIn(
      { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-02T00:00:00Z') },
      [
        record('2026-01-01T00:00:00Z'),
        record('2026-01-01T23:59:59.999Z'),
        record('2026-01-02T00:00:00Z'),
      ],
    );
    expect(usage.requests).toBe(2);
  });

  it('places a fixed-daily window at exact Pacific midnight', () => {
    const spec = { kind: 'fixed_daily' as const, tz: PT, time: '00:00' };
    const atMidnight = new Date('2026-09-24T07:00:00.000Z');
    expect(windowStart(atMidnight, spec).toISOString()).toBe('2026-09-24T07:00:00.000Z');
    expect(nextReset(atMidnight, spec).toISOString()).toBe('2026-09-25T07:00:00.000Z');
  });

  it('keeps windowStart <= now < nextReset across both DST transitions and a gap time', () => {
    const specs = [
      { kind: 'fixed_daily' as const, tz: PT, time: '00:00' },
      { kind: 'fixed_daily' as const, tz: PT, time: '02:30' },
      { kind: 'fixed_daily' as const, tz: PT, time: '01:30' },
      { kind: 'weekly_fixed' as const, dow: 1, tz: PT, time: '02:30' },
    ];
    const instants = [
      '2026-03-08T09:30:00.000Z',
      '2026-03-08T10:30:00.000Z',
      '2026-11-01T08:30:00.000Z',
      '2026-11-01T09:30:00.000Z',
    ];
    for (const spec of specs) {
      for (const instant of instants) {
        const now = new Date(instant);
        const start = windowStart(now, spec);
        const reset = nextReset(now, spec);
        const label = `${'time' in spec ? spec.time : ''} ${instant}`;
        expect(start.getTime(), label).toBeLessThanOrEqual(now.getTime());
        expect(reset.getTime(), label).toBeGreaterThan(now.getTime());
        expect(Number.isNaN(start.getTime()), instant).toBe(false);
        expect(Number.isNaN(reset.getTime()), instant).toBe(false);
      }
    }
  });

  it('anchors weekly_from_first_use to the earliest record', () => {
    const spec = { kind: 'weekly_from_first_use' as const, tz: 'UTC' };
    const records = [record('2026-05-01T03:00:00Z'), record('2026-05-20T03:00:00Z')];
    const now = new Date('2026-05-23T00:00:00Z');
    const start = windowStart(now, spec, records);
    expect(start.toISOString()).toBe('2026-05-22T03:00:00.000Z');
    expect(nextReset(now, spec, records).toISOString()).toBe('2026-05-29T03:00:00.000Z');
  });

  it('never returns negative remaining and never exceeds the limit for non-negative usage', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.option(fc.integer({ min: 0, max: 1_000_000_000 }), { nil: undefined }),
        (limit, usage, authoritative) => {
          const value = remaining(limit, usage, authoritative);
          if (value === null) return true;
          return value >= 0 && value <= Math.max(limit, authoritative ?? 0);
        },
      ),
    );
  });

  it('clamps remaining to zero when usage exceeds the limit', () => {
    expect(remaining(5, 100)).toBe(0);
    expect(remaining(0, 0)).toBe(0);
    expect(remaining(null, 5)).toBeNull();
  });
});

const provider = {
  provider: 'gemini',
  name: 'Gemini',
  tag: 'legit' as const,
  signup_url: null,
  docs_url: null,
  terms_note: '',
  data_use: '',
  verified_at: '2026-01-01',
  source_url: 'https://example.com',
  windows: [
    {
      scope: 'provider' as const,
      metric: 'requests' as const,
      kind: 'fixed_daily' as const,
      tz: 'UTC',
      limit: 20,
    },
  ],
};

const engines: QuotaEngine[] = [];
function makeEngine(options: ConstructorParameters<typeof QuotaEngine>[0] = {}): QuotaEngine {
  const engine = new QuotaEngine({ now: () => new Date('2026-06-01T10:00:00Z'), ...options });
  engines.push(engine);
  return engine;
}
afterEach(() => {
  while (engines.length) engines.pop()?.dispose();
});

describe('QA quota: engine hostile inputs', () => {
  it('is order-independent for out-of-order usage records', () => {
    const times = [
      '2026-06-01T09:10:00Z',
      '2026-06-01T09:50:00Z',
      '2026-06-01T09:30:00Z',
      '2026-06-01T09:20:00Z',
    ];
    const forward = makeEngine({ catalog: { providers: [provider], models: [] } });
    for (const time of times) forward.recordUsage(record(time));
    const backward = makeEngine({ catalog: { providers: [provider], models: [] } });
    for (const time of [...times].reverse()) backward.recordUsage(record(time));
    expect(forward.getWindows('gemini')[0]?.used).toBe(backward.getWindows('gemini')[0]?.used);
    expect(forward.getWindows('gemini')[0]?.used).toBe(4);
  });

  it('keeps capacity percentages within [0,100] and non-negative', () => {
    const engine = makeEngine({ catalog: { providers: [provider], models: [] } });
    for (let i = 0; i < 25; i += 1)
      engine.recordUsage(record(`2026-06-01T09:0${String(i % 10)}:00Z`));
    const summary = engine.capacitySummary();
    expect(CapacitySummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.percentRemaining).toBeGreaterThanOrEqual(0);
    expect(summary.percentRemaining).toBeLessThanOrEqual(100);
  });

  it('signals a low-capacity banner only when the restrictive window is truly low', () => {
    const engine = makeEngine({
      catalog: {
        providers: [
          {
            ...provider,
            windows: [
              {
                scope: 'provider' as const,
                metric: 'requests' as const,
                kind: 'fixed_daily' as const,
                tz: 'UTC',
                limit: 4,
              },
            ],
          },
        ],
        models: [],
      },
      lowCapacityThreshold: 50,
    });
    for (let i = 0; i < 3; i += 1) engine.recordUsage(record(`2026-06-01T09:0${String(i)}:00Z`));
    expect(engine.capacitySummary().banner?.text).toContain('gemini');
  });

  it('does not let negative usage inflate remaining capacity above the limit', () => {
    // BUG: recordUsage() does no runtime validation, so a negative token count
    // flows into usageIn() and remaining() = limit - (negative) exceeds the limit,
    // pushing the capacity percentage above 100.
    const tokenProvider = {
      ...provider,
      windows: [
        {
          scope: 'provider' as const,
          metric: 'tokens' as const,
          kind: 'fixed_daily' as const,
          tz: 'UTC',
          limit: 100,
        },
      ],
    };
    const engine = makeEngine({ catalog: { providers: [tokenProvider], models: [] } });
    engine.recordUsage(
      record('2026-06-01T09:00:00Z', { inputTokens: -1_000_000, outputTokens: 0 }),
    );
    const window = engine.getWindows('gemini')[0];
    expect(window?.remaining).toBeLessThanOrEqual(window?.limit ?? 0);
    expect(CapacitySummarySchema.safeParse(engine.capacitySummary()).success).toBe(true);
  });

  it('does not report zero steps left when only a short rolling window is restrictive', () => {
    // BUG: stepsFor() adds a "seconds until reset" candidate for rolling windows;
    // nextReset() for rolling windows equals now, so the candidate is 0 and the
    // minimum collapses stepsLeftToday to 0 even when a daily window is ample.
    const mixed = {
      ...provider,
      windows: [
        {
          scope: 'provider' as const,
          metric: 'requests' as const,
          kind: 'fixed_daily' as const,
          tz: 'UTC',
          limit: 20,
        },
        {
          scope: 'provider' as const,
          metric: 'requests' as const,
          kind: 'rolling' as const,
          length: 60,
          limit: 4,
        },
      ],
    };
    const model: ModelInfo = {
      ref: ModelRefSchema.parse('gemini/gemini-flash'),
      providerId: ProviderIdSchema.parse('gemini'),
      name: 'Flash',
      tier: 'T1',
      contextWindow: 100_000,
      maxOutput: 8_000,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: null,
      priceOutPerM: null,
    };
    const engine = makeEngine({ catalog: { providers: [mixed], models: [model] } });
    engine.recordUsage(record('2026-06-01T09:00:00Z', { stepKind: 'edit' }));
    expect(engine.stepsLeft('gemini', model.ref)).toBeGreaterThan(0);
  });

  it('converges a learned limit toward the catalog limit without going negative', () => {
    const engine = makeEngine({ catalog: { providers: [provider], models: [] } });
    engine.recordUsage(record('2026-06-01T09:50:00Z'));
    engine.recordUsage(record('2026-06-01T09:55:00Z'));
    const id = engine.getWindows('gemini')[0]?.id;
    if (!id) throw new Error('no window');
    engine.observe({
      id: '429',
      providerId: 'gemini' as UsageRecord['providerId'],
      windowId: id,
      metric: 'requests',
      source: 'header',
      observedAt: '2026-06-01T10:00:00Z',
      statusCode: 429,
    });
    for (let i = 0; i < 5; i += 1) {
      const window = engine.getWindows('gemini')[0];
      expect(window?.limit ?? 0).toBeGreaterThanOrEqual(0);
      expect(window?.remaining ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});
