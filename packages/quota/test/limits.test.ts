import { afterEach, describe, expect, it } from 'vitest';
import { ProviderIdSchema, ProviderLimitsSchema, type UsageRecord } from '@ferry/shared';
import type { Catalog, ProviderLimits } from '@ferry/catalog';
import {
  catalogWindowId,
  matchesQuotaModel,
  observationsFromRateLimitHeaders,
  QuotaEngine,
  observationsFromProbe,
} from '../src/index.js';

const now = new Date('2026-10-07T12:00:00Z');
const provider = (
  id: string,
  windows: ProviderLimits['windows'],
  tag: ProviderLimits['tag'] = 'legit',
): ProviderLimits => ({
  provider: id,
  name: id,
  tag,
  windows,
  signup_url: null,
  docs_url: null,
  terms_note: '',
  data_use: '',
  verified_at: '2026-10-07',
  source_url: 'https://example.com',
});
const daily = { scope: 'provider', metric: 'requests', kind: 'fixed_daily', limit: 100 } as const;
const minute = { ...daily, kind: 'rolling', length: 60 } as const;
const engines: QuotaEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function engine(providers: Catalog['providers']) {
  const value = new QuotaEngine({ catalog: { models: [], providers }, now: () => now });
  engines.push(value);
  return value;
}
function observations(
  id: string,
  headers: Record<string, string>,
  windows: ProviderLimits['windows'],
  model = `${id}/thinker`,
) {
  return observationsFromRateLimitHeaders(
    {
      providerId: ProviderIdSchema.parse(id),
      modelRef: model,
      startedAt: now.getTime(),
      latencyMs: 10,
      statusCode: 200,
      requestBytes: 10,
      rateLimitHeaders: headers,
      errorKind: null,
    },
    windows,
    now,
  );
}

describe('honest provider limits', () => {
  it('binds unsuffixed generic probe request headers to minute windows', () => {
    const rows = observationsFromProbe({
      providerId: ProviderIdSchema.parse('openai'),
      definitions: [minute, daily],
      source: 'header',
      observedAt: now.toISOString(),
      windows: [
        {
          id: 'generic:requests',
          scope: 'provider',
          modelRef: null,
          metric: 'requests',
          kind: 'dynamic',
          periodLabel: 'generic:requests',
          used: 7,
          limit: 20,
          remaining: 13,
          resetAt: '2026-10-07T12:01:00Z',
          confidence: 'exact',
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.windowId).toBe(catalogWindowId('openai', minute));
    const quota = engine([provider('openai', [minute, daily])]);
    rows.forEach((row) => {
      quota.observe(row);
    });
    expect(quota.getWindows('openai')[0]?.remaining).toBe(13);
    expect(quota.limits()[0]?.windows[0]?.remaining).toBe(100);
  });
  it('does not present hourly windows as daily capacity or invalidate headers without reset timestamps', () => {
    const quota = engine([provider('custom', [{ ...minute, length: 3600 }])]);
    observations(
      'custom',
      { 'x-ratelimit-limit-requests-hour': '150', 'x-ratelimit-remaining-requests-hour': '140' },
      [{ ...minute, length: 3600 }],
    ).forEach((row) => {
      quota.observe(row);
    });
    expect(quota.getWindows('custom')[0]).toMatchObject({
      limit: 150,
      remaining: 140,
      durationMs: 3_600_000,
    });
    expect(quota.getWindows('custom')[0]?.resetAt).toBe('2026-10-07T13:00:00.000Z');
    expect(quota.limits()[0]?.windows).toEqual([]);
    expect(quota.stepsLeft('custom', 'custom/thinker')).toBeNull();
  });
  it('binds probe windows by period and preserves endpoint provenance', () => {
    const rows = observationsFromProbe({
      providerId: ProviderIdSchema.parse('custom'),
      modelRef: 'custom/thinker',
      definitions: [minute, daily],
      source: 'endpoint',
      observedAt: now.toISOString(),
      windows: [
        {
          id: 'requests-day',
          scope: 'provider',
          modelRef: null,
          metric: 'requests',
          kind: 'fixed_daily',
          periodLabel: 'requests-day',
          used: 20,
          limit: 100,
          remaining: 80,
          resetAt: '2026-10-08T00:00:00Z',
          confidence: 'exact',
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      windowId: catalogWindowId('custom', daily),
      source: 'endpoint',
      limit: 100,
      remaining: 80,
    });
    const quota = engine([provider('custom', [minute, daily])]);
    rows.forEach((row) => {
      quota.observe(row);
    });
    expect(quota.limits()[0]?.windows[0]?.source).toBe('endpoint');
  });
  it.each(['openai', 'anthropic', 'cerebras'])(
    'maps %s minute headers without overwriting daily windows and pairs values',
    (id) => {
      const prefix = id === 'anthropic' ? 'anthropic-ratelimit-requests-' : 'x-ratelimit-';
      const headers =
        id === 'anthropic'
          ? {
              [`${prefix}limit`]: '20',
              [`${prefix}remaining`]: '17',
              [`${prefix}reset`]: '2026-10-07T12:01:00Z',
            }
          : {
              [`${prefix}limit-requests`]: '20',
              [`${prefix}remaining-requests`]: '17',
              [`${prefix}reset-requests`]: '1m',
            };
      const windows = [minute, daily];
      const rows = observations(id, headers, windows);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        windowId: catalogWindowId(id, minute),
        limit: 20,
        remaining: 17,
        value: 3,
        resetAt: '2026-10-07T12:01:00.000Z',
      });
      const quota = engine([provider(id, windows)]);
      rows.forEach((row) => {
        quota.observe(row);
      });
      expect(quota.limits()[0]?.windows).toEqual([
        expect.objectContaining({ limit: 100, remaining: 100, source: 'published' }),
      ]);
    },
  );
  it('maps Groq unsuffixed requests to daily and tokens to minute, scoped to the precise model', () => {
    const windows = [
      { ...daily, scope: 'model' as const, model: 'gpt-oss-120b' },
      { ...minute, scope: 'model' as const, model: 'gpt-oss-120b', metric: 'tokens' as const },
      { ...daily, metric: 'tokens' as const, scope: 'model' as const, model: 'gpt-oss-120b' },
    ];
    const rows = observations(
      'groq',
      {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '900',
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '7000',
      },
      windows,
      'groq/openai/gpt-oss-120b',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      modelRef: 'groq/openai/gpt-oss-120b',
      period: 'day',
      limit: 1000,
      remaining: 900,
    });
    expect(rows[1]?.period).toBe('minute');
  });
  it('distinguishes Cerebras minute, hour, day, monthly and token header groups', () => {
    const windows = [
      minute,
      { ...minute, length: 3600 },
      daily,
      { ...daily, kind: 'monthly_from_anchor' as const, day: 1 },
      { ...daily, metric: 'tokens' as const },
    ];
    const rows = observations(
      'cerebras',
      {
        'x-ratelimit-limit-requests-minute': '5',
        'x-ratelimit-remaining-requests-minute': '4',
        'x-ratelimit-limit-requests-hour': '150',
        'x-ratelimit-remaining-requests-hour': '140',
        'x-ratelimit-limit-requests-day': '2400',
        'x-ratelimit-remaining-requests-day': '2200',
        'x-ratelimit-limit-tokens-day': '1000000',
        'x-ratelimit-remaining-tokens-day': '900000',
        'x-ratelimit-limit-requests-month': '10000',
        'x-ratelimit-remaining-requests-month': '9900',
      },
      windows,
    );
    expect(new Set(rows.map((row) => row.windowId)).size).toBe(5);
    const quota = engine([provider('cerebras', windows)]);
    rows.forEach((row) => {
      quota.observe(row);
    });
    expect(quota.getWindows('cerebras')[0]?.durationMs).toBe(60_000);
    expect(quota.getWindows('cerebras')[1]?.durationMs).toBe(3_600_000);
    expect(quota.limits()[0]?.windows).toHaveLength(3);
    expect(quota.limits()[0]?.windows[0]).toMatchObject({
      period: 'day',
      limit: 2400,
      used: 200,
      remaining: 2200,
      source: 'header',
    });
  });
  it('matches complete ids and globs, without substring or family matches', () => {
    expect(matchesQuotaModel('groq', 'groq/openai/gpt-oss-120b', 'gpt-oss-120b')).toBe(true);
    expect(matchesQuotaModel('groq', 'groq/openai/gpt-oss-120b-extended', 'gpt-oss-120b')).toBe(
      false,
    );
    expect(matchesQuotaModel('groq', 'other/gpt-oss-120b', '*')).toBe(false);
    expect(matchesQuotaModel('groq', 'groq/openai/gpt-oss-120b', 'openai/gpt-oss-*')).toBe(true);
  });
  it('keeps matching glob models separate, including usage and observations', () => {
    const windows = [{ ...daily, scope: 'model' as const, model: 'thinker-*' }];
    const quota = engine([provider('custom', windows)]);
    for (const [index, modelRef] of [
      'custom/thinker-a',
      'custom/thinker-b',
      'custom/other-thinker-a',
    ].entries())
      quota.recordUsage({
        id: String(index),
        providerId: ProviderIdSchema.parse('custom'),
        modelRef,
        occurredAt: '2026-10-07T11:00:00Z',
        status: 'success',
      } satisfies UsageRecord);
    observations(
      'custom',
      { 'x-ratelimit-limit-requests-day': '100', 'x-ratelimit-remaining-requests-day': '80' },
      windows,
      'custom/thinker-a',
    ).forEach((row) => {
      quota.observe(row);
    });
    expect(quota.limits()[0]?.windows).toEqual([
      expect.objectContaining({ model: 'custom/thinker-a', used: 20, remaining: 80 }),
      expect.objectContaining({ model: 'custom/thinker-b', used: 1, remaining: 99 }),
    ]);
  });
  it('represents unknown and paid providers without invented totals, and exposes newly observed periods', () => {
    const quota = engine([provider('unknown', []), provider('paid', [], 'paid')]);
    expect(quota.limits().map((row) => row.state)).toEqual(['no_published_limit', 'paid_no_limit']);
    observations(
      'paid',
      { 'x-ratelimit-limit-requests-day': '200', 'x-ratelimit-remaining-requests-day': '190' },
      [],
    ).forEach((row) => {
      quota.observe(row);
    });
    expect(quota.limits()[1]).toMatchObject({
      state: 'known',
      windows: [
        expect.objectContaining({ source: 'header', period: 'day', used: 10, remaining: 190 }),
      ],
    });
    quota.limits().forEach((row) => ProviderLimitsSchema.parse(row));
  });
});
