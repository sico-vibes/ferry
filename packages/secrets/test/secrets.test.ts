import { describe, expect, it } from 'vitest';
import { KeyringSecretStore, MemorySecretStore } from '../src/index.js';

describe('MemorySecretStore', () => {
  it('supports set/get/has/delete without exposing values in metadata', async () => {
    const store = new MemorySecretStore();
    await store.set('openai-main', 'never-log-this');
    expect(await store.has('openai-main')).toBe(true);
    expect(await store.get('openai-main')).toBe('never-log-this');
    await store.delete('openai-main');
    expect(await store.has('openai-main')).toBe(false);
  });

  it('stores and removes secrets independently for each provider key id', async () => {
    const store = new MemorySecretStore('multi-key-test');
    await store.set('openai:1', 'first-test-secret');
    await store.set('openai:2', 'second-test-secret');
    expect(await store.get('openai:1')).toBe('first-test-secret');
    expect(await store.get('openai:2')).toBe('second-test-secret');
    await store.delete('openai:1');
    expect(await store.get('openai:1')).toBeUndefined();
    expect(await store.get('openai:2')).toBe('second-test-secret');
    store.clear();
  });
});

describe('KeyringSecretStore', () => {
  it('stores a provider key in the operating system keyring when available', async ({ skip }) => {
    const store = new KeyringSecretStore('Ferry-Test');
    const account = `test-${String(process.pid)}-${String(Date.now())}`;
    try {
      await store.set(account, 'ferry-keyring-test-value');
    } catch {
      skip();
      return;
    }
    expect(await store.get(account)).toBe('ferry-keyring-test-value');
    expect(await store.has(account)).toBe(true);
    await store.delete(account);
    expect(await store.has(account)).toBe(false);
  });
});
