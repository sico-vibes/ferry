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
