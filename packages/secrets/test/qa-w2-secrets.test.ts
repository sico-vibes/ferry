import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/index.js';

describe('QA-w2 secrets: memory keyring isolation and deletion', () => {
  it('delete removes the value for real (get undefined, has false) and permits a re-set', async () => {
    const store = new MemorySecretStore('qa-w2');
    await store.set('openai', 'sk-first-value');
    expect(await store.get('openai')).toBe('sk-first-value');
    await store.delete('openai');
    expect(await store.get('openai')).toBeUndefined();
    expect(await store.has('openai')).toBe(false);
    await store.set('openai', 'sk-second-value');
    expect(await store.get('openai')).toBe('sk-second-value');
  });

  it('deleting a missing key is a no-op and never resurrects a previous value', async () => {
    const store = new MemorySecretStore('qa-w2');
    await store.set('gemini', 'secret');
    await store.delete('gemini');
    await store.delete('gemini');
    expect(await store.get('gemini')).toBeUndefined();
  });

  it('isolates accounts by namespace prefix', async () => {
    const test = new MemorySecretStore('qa-w2');
    const prod = new MemorySecretStore('prod');
    await test.set('openai', 'namespace-value');
    expect(await prod.get('openai')).toBeUndefined();
    expect(await test.get('openai')).toBe('namespace-value');
  });

  it('clear() wipes every account and cannot be undone by a stale reference', async () => {
    const store = new MemorySecretStore('qa-w2');
    await Promise.all([store.set('openai', 'a'), store.set('gemini', 'b'), store.set('groq', 'c')]);
    store.clear();
    expect(await store.get('openai')).toBeUndefined();
    expect(await store.get('gemini')).toBeUndefined();
    expect(await store.get('groq')).toBeUndefined();
  });

  it('never exposes stored values through enumeration or serialization', async () => {
    const store = new MemorySecretStore('qa-w2');
    const secret = 'sk-never-serialize-me-0123456789';
    await store.set('openai', secret);
    const surfaces = [
      JSON.stringify(store),
      JSON.stringify(Object.keys(store)),
      JSON.stringify(Object.values(store)),
      JSON.stringify(Object.entries(store)),
      JSON.stringify(Object.getOwnPropertyNames(store)),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(secret);
  });

  it('keeps concurrent set/delete on one account consistent', async () => {
    const store = new MemorySecretStore('qa-w2');
    await store.set('openai', 'seed');
    await Promise.all([
      store.delete('openai'),
      store.set('openai', 'value-a'),
      store.delete('openai'),
      store.set('openai', 'value-b'),
    ]);
    const value = await store.get('openai');
    expect(value === undefined || value === 'value-a' || value === 'value-b').toBe(true);
    expect((await store.has('openai')) === (value !== undefined)).toBe(true);
  });

  it('accepts opaque account ids without touching a real keyring', async () => {
    const store = new MemorySecretStore('qa-w2');
    await store.set('', 'empty-id');
    await store.set('\u96ea/..\\\u0000', 'unicode-id');
    expect(await store.get('')).toBe('empty-id');
    expect(await store.get('\u96ea/..\\\u0000')).toBe('unicode-id');
  });
});
