import type { SecretStore } from '@ferry/secrets';
import type { SupabaseVaultSecretStore } from './vault-secret-store.js';

export interface LocalKeyEntry {
  id: string;
  providerId: string;
  keyringRef: string;
}
export interface KeyMigrationCounts {
  migrated: number;
  missing: number;
  failed: number;
}

/** Copies available local keychain secrets to Vault and returns counts without exposing values. */
export async function migrateLocalKeysToVault(input: {
  local: SecretStore;
  vault: SupabaseVaultSecretStore;
  entries: readonly LocalKeyEntry[];
}): Promise<KeyMigrationCounts> {
  const counts: KeyMigrationCounts = { migrated: 0, missing: 0, failed: 0 };
  for (const entry of input.entries) {
    try {
      const secret = await input.local.get(entry.keyringRef);
      if (!secret) {
        counts.missing += 1;
        continue;
      }
      // Ferry refs already encode their provider prefix (including oauth:<provider>).
      await input.vault.set(entry.id, secret);
      counts.migrated += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}
