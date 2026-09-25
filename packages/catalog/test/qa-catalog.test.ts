import { describe, expect, it } from 'vitest';
import { ModelInfoSchema, ProviderTagSchema } from '@ferry/shared';
import { loadCatalog, normalizeModels, ProviderLimitsSchema } from '../src/index.js';

describe('QA catalog: snapshot normalization', () => {
  it('drops invalid models and fills safe defaults', () => {
    const models = normalizeModels({
      p: {
        models: {
          good: { id: 'good', cost: { input: 0, output: 0 }, limit: { context: 1000 } },
          negative: { id: 'negative', limit: { context: 0 } },
          paid: { id: 'paid', cost: { input: 1, output: 2 }, tool_call: true },
        },
      },
      empty: {},
    });
    expect(models.every((model) => ModelInfoSchema.safeParse(model).success)).toBe(true);
    const refs = models.map((model) => model.ref);
    expect(refs).toContain('p/good');
    expect(refs).not.toContain('p/negative');
    const free = models.find((model) => model.ref === 'p/good');
    const paid = models.find((model) => model.ref === 'p/paid');
    expect(free?.free).toBe(true);
    expect(paid?.free).toBe(false);
    expect(paid?.contextWindow).toBeGreaterThan(0);
  });

  it('applies tier overrides by ref and by bare id', () => {
    const snapshot = { p: { models: { m: { id: 'm', limit: { context: 100 } } } } };
    expect(
      normalizeModels(snapshot, { 'p/m': { tier: 'T1', tool_reliability_prior: 1 } })[0]?.tier,
    ).toBe('T1');
    expect(
      normalizeModels(snapshot, { m: { tier: 'T3', tool_reliability_prior: 0 } })[0]?.tier,
    ).toBe('T3');
  });

  it.fails('returns no models for a null snapshot instead of throwing', () => {
    // BUG: normalizeModels() calls Object.entries() on the raw input, which
    // throws a TypeError when a (corrupted) snapshot parses to null.
    expect(() => normalizeModels(null)).not.toThrow();
  });
});

describe('QA catalog: limits schema and loading', () => {
  it('rejects malformed limit windows', () => {
    const base = {
      provider: 'x',
      name: 'X',
      tag: 'legit',
      signup_url: null,
      docs_url: null,
      terms_note: '',
      data_use: '',
      verified_at: '2026-01-01',
      source_url: 'https://example.com',
    };
    expect(
      ProviderLimitsSchema.safeParse({
        ...base,
        windows: [
          { scope: 'provider', metric: 'requests', kind: 'fixed_daily', time: '9:5', limit: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProviderLimitsSchema.safeParse({
        ...base,
        windows: [
          { scope: 'provider', metric: 'requests', kind: 'weekly_fixed', dow: 9, limit: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProviderLimitsSchema.safeParse({
        ...base,
        windows: [{ scope: 'provider', metric: 'requests', kind: 'rolling', length: -5, limit: 1 }],
      }).success,
    ).toBe(false);
    expect(
      ProviderLimitsSchema.safeParse({
        ...base,
        windows: [{ scope: 'provider', metric: 'requests', kind: 'rolling', limit: -1 }],
      }).success,
    ).toBe(false);
  });

  it('flags stale provider limits relative to an injected clock', async () => {
    const fresh = await loadCatalog({ now: new Date('2026-01-01T00:00:00Z') });
    const stale = await loadCatalog({ now: new Date('2030-01-01T00:00:00Z') });
    expect(fresh.warnings.length).toBeLessThanOrEqual(fresh.providers.length);
    expect(stale.warnings.length).toBe(stale.providers.filter((provider) => !provider.dead).length);
    expect(stale.warnings.every((warning) => warning.includes('older than 60 days'))).toBe(true);
  });

  it('hides dead providers unless requested and keeps tags valid', async () => {
    const hidden = await loadCatalog({ includeDead: false });
    const shown = await loadCatalog({ includeDead: true });
    expect(hidden.providers.every((provider) => !provider.dead)).toBe(true);
    expect(shown.providers.length).toBeGreaterThanOrEqual(hidden.providers.length);
    expect(
      hidden.providers.every((provider) => ProviderTagSchema.safeParse(provider.tag).success),
    ).toBe(true);
  });
});
