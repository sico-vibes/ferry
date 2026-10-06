import type { SecretStore } from '@ferry/secrets';

async function attempt<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action();
  } catch {
    return fallback;
  }
}

/**
 * Cloud-mode secret store: Vault is the source of truth, and the local keychain answers reads
 * when Vault cannot (signed out, offline, or a key not copied to Vault yet). Without this, losing
 * the connection would leave Ferry with no provider keys at all. Writes and deletes go to Vault.
 */
export class VaultWithLocalFallbackSecretStore implements SecretStore {
  constructor(
    private readonly vault: SecretStore,
    private readonly local: SecretStore,
  ) {}
  async set(providerKeyId: string, value: string): Promise<void> {
    await this.vault.set(providerKeyId, value);
  }
  async get(providerKeyId: string): Promise<string | undefined> {
    const remote = await attempt(() => this.vault.get(providerKeyId), undefined);
    return remote ?? (await attempt(() => this.local.get(providerKeyId), undefined));
  }
  async delete(providerKeyId: string): Promise<void> {
    await this.vault.delete(providerKeyId);
  }
  async has(providerKeyId: string): Promise<boolean> {
    if (await attempt(() => this.vault.has(providerKeyId), false)) return true;
    return await attempt(() => this.local.has(providerKeyId), false);
  }
}
