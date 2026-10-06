import { describe, expect, it } from 'vitest';
import type { SecretStore } from '@ferry/secrets';
import { VaultWithLocalFallbackSecretStore } from '../src/index.js';

function memory(values: Record<string, string> = {}, failing = false): SecretStore {
  const store = new Map(Object.entries(values));
  const guard = () => {
    if (failing) throw new Error('offline');
  };
  return {
    set: (id, value) => {
      guard();
      store.set(id, value);
      return Promise.resolve();
    },
    get: (id) => {
      guard();
      return Promise.resolve(store.get(id));
    },
    delete: (id) => {
      guard();
      store.delete(id);
      return Promise.resolve();
    },
    has: (id) => {
      guard();
      return Promise.resolve(store.has(id));
    },
  };
}

describe('VaultWithLocalFallbackSecretStore', () => {
  it('prefers Vault and falls back to the local keychain when Vault has no key', async () => {
    const store = new VaultWithLocalFallbackSecretStore(
      memory({ 'groq:1': 'vault-key' }),
      memory({ 'groq:1': 'local-key', 'gemini:1': 'local-gemini' }),
    );
    expect(await store.get('groq:1')).toBe('vault-key');
    expect(await store.get('gemini:1')).toBe('local-gemini');
    expect(await store.has('gemini:1')).toBe(true);
  });

  it('keeps local keys usable while Vault is unreachable', async () => {
    const store = new VaultWithLocalFallbackSecretStore(
      memory({}, true),
      memory({ 'groq:1': 'local-key' }),
    );
    expect(await store.get('groq:1')).toBe('local-key');
    expect(await store.has('groq:1')).toBe(true);
  });

  it('writes only to Vault', async () => {
    const local = memory();
    const store = new VaultWithLocalFallbackSecretStore(memory(), local);
    await store.set('groq:1', 'new-key');
    expect(await local.has('groq:1')).toBe(false);
    expect(await store.get('groq:1')).toBe('new-key');
  });
});
