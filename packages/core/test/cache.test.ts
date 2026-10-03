import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/cache.js';

describe('TTL cache', () => {
  it('coalesces concurrent loads, expires entries and supports invalidation', async () => {
    let now = 0;
    let calls = 0;
    const cache = new TtlCache<string>(() => now);
    const load = () => {
      calls += 1;
      return Promise.resolve('catalog');
    };
    await expect(
      Promise.all([cache.getOrLoad('catalog', 10, load), cache.getOrLoad('catalog', 10, load)]),
    ).resolves.toEqual(['catalog', 'catalog']);
    expect(calls).toBe(1);
    await cache.getOrLoad('catalog', 10, load);
    expect(calls).toBe(1);
    now = 11;
    await cache.getOrLoad('catalog', 10, load);
    expect(calls).toBe(2);
    cache.invalidate('catalog');
    await cache.getOrLoad('catalog', 10, load);
    expect(calls).toBe(3);
  });

  it('never caches empty or fallback results', async () => {
    let calls = 0;
    const cache = new TtlCache<readonly string[]>();
    const load = () => {
      calls += 1;
      return [];
    };
    await cache.getOrLoad('models', 60_000, load, (models) => models.length > 0);
    await cache.getOrLoad('models', 60_000, load, (models) => models.length > 0);
    expect(calls).toBe(2);
  });

  it('does not let an invalidated in-flight load repopulate the cache', async () => {
    let resolveOld: ((value: string) => void) | undefined;
    let calls = 0;
    const cache = new TtlCache<string>();
    const oldLoad = cache.getOrLoad(
      'providers',
      60_000,
      () => new Promise<string>((resolve) => (resolveOld = resolve)),
    );
    await Promise.resolve();
    cache.invalidate('providers');
    const freshLoad = cache.getOrLoad('providers', 60_000, () => {
      calls += 1;
      return 'fresh';
    });
    resolveOld?.('stale');
    await expect(oldLoad).resolves.toBe('stale');
    await expect(freshLoad).resolves.toBe('fresh');
    await expect(cache.getOrLoad('providers', 60_000, () => 'unexpected')).resolves.toBe('fresh');
    expect(calls).toBe(1);
  });
});
