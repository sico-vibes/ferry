import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/index.js';

describe('QA secrets: memory store', () => {
  it('supports the full lifecycle and overwrite', async () => {
    const store = new MemorySecretStore();
    expect(await store.get('missing')).toBeUndefined();
    expect(await store.has('p')).toBe(false);
    await store.set('p', 'first');
    await store.set('p', 'second');
    expect(await store.get('p')).toBe('second');
    expect(await store.has('p')).toBe(true);
    await store.delete('p');
    expect(await store.has('p')).toBe(false);
    await expect(store.delete('p')).resolves.toBeUndefined();
  });

  it('does not expose secret values through serialization or enumeration', async () => {
    const store = new MemorySecretStore();
    await store.set('p', 'super-secret-value');
    expect(JSON.stringify(store)).not.toContain('super-secret-value');
    expect(Object.keys(store)).toHaveLength(0);
    expect(Object.values(store)).toHaveLength(0);
  });

  it('keeps distinct accounts isolated under concurrent access', async () => {
    const store = new MemorySecretStore();
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => store.set(`acct-${String(i)}`, `value-${String(i)}`)),
      store.set('shared', 'a'),
      store.set('shared', 'b'),
    ]);
    for (let i = 0; i < 20; i += 1)
      expect(await store.get(`acct-${String(i)}`)).toBe(`value-${String(i)}`);
    expect(['a', 'b']).toContain(await store.get('shared'));
  });

  it('treats empty and unicode account ids as opaque keys', async () => {
    const store = new MemorySecretStore();
    await store.set('', 'empty');
    await store.set('\u96ea/../\u0000', 'unicode');
    expect(await store.get('')).toBe('empty');
    expect(await store.get('\u96ea/../\u0000')).toBe('unicode');
  });
});
