import { forgetSecret, isKnownSecret, rememberSecret } from '@ferry/shared';
import type { SecretStore } from '@ferry/secrets';
import { FERRY_CLOUD_SCHEMA } from './config.js';
import { friendlyAuthError } from './auth.js';
import type { FerrySupabaseClient } from './client.js';

/** Metadata-only provider key lifecycle callback. */
export type ProviderKeyEvent = (event: {
  kind: 'set' | 'rotate' | 'delete' | 'use';
  providerId: string;
  keyId: string;
}) => void;
/** SecretStore implementation that delegates all key material to Supabase Vault RPCs. */
export class SupabaseVaultSecretStore implements SecretStore {
  readonly #cache = new Map<string, string>();
  readonly #lastUseEvent = new Map<string, number>();
  constructor(
    private readonly client: FerrySupabaseClient,
    private readonly schema = FERRY_CLOUD_SCHEMA,
    private readonly onEvent?: ProviderKeyEvent,
    private readonly isSignedIn: () => boolean = () => true,
  ) {}
  async set(providerKeyId: string, value: string): Promise<void> {
    if (!this.isSignedIn()) throw new Error('Cloud sign-in required to manage provider keys');
    const providerId = providerKeyId.split(':')[0] ?? providerKeyId;
    const rotating =
      this.#cache.has(providerKeyId) || (this.onEvent ? await this.has(providerKeyId) : false);
    const { error } = await this.client.schema(this.schema).rpc('set_provider_key', {
      p_provider_id: providerId,
      p_secret: value,
      p_label: null,
      p_key_id: providerKeyId,
    });
    if (error) throw new Error(`Cloud key save failed: ${friendlyAuthError(error.message)}`);
    const old = this.#cache.get(providerKeyId);
    if (old !== value) {
      if (old) forgetSecret(old);
      this.#cache.set(providerKeyId, value);
      rememberSecret(value);
    }
    this.onEvent?.({ kind: rotating ? 'rotate' : 'set', providerId, keyId: providerKeyId });
  }
  async get(providerKeyId: string): Promise<string | undefined> {
    if (!this.isSignedIn()) return undefined;
    const cached = this.#cache.get(providerKeyId);
    if (cached) {
      this.emitUse(providerKeyId);
      return cached;
    }
    const { data, error } = (await this.client
      .schema(this.schema)
      .rpc('get_provider_key_secret', { p_key_id: providerKeyId })) as {
      data: unknown;
      error: { message: string } | null;
    };
    if (error) throw new Error(`Cloud key retrieval failed: ${friendlyAuthError(error.message)}`);
    const value = typeof data === 'string' ? data : undefined;
    if (value) {
      this.#cache.set(providerKeyId, value);
      if (!isKnownSecret(value)) rememberSecret(value);
      this.emitUse(providerKeyId);
    }
    return value;
  }
  async delete(providerKeyId: string): Promise<void> {
    if (!this.isSignedIn()) throw new Error('Cloud sign-in required to manage provider keys');
    const { error } = await this.client
      .schema(this.schema)
      .rpc('delete_provider_key', { p_key_id: providerKeyId });
    if (error) throw new Error(`Cloud key delete failed: ${friendlyAuthError(error.message)}`);
    const old = this.#cache.get(providerKeyId);
    if (old) forgetSecret(old);
    this.#cache.delete(providerKeyId);
    this.onEvent?.({
      kind: 'delete',
      providerId: providerKeyId.split(':')[0] ?? providerKeyId,
      keyId: providerKeyId,
    });
  }
  async has(providerKeyId: string): Promise<boolean> {
    if (!this.isSignedIn()) return false;
    const { data, error } = await this.client
      .schema(this.schema)
      .from('provider_keys')
      .select('id')
      .eq('id', providerKeyId)
      .maybeSingle();
    if (error) throw new Error(`Cloud key status failed: ${friendlyAuthError(error.message)}`);
    return Boolean(data);
  }
  clearCache(): void {
    for (const value of this.#cache.values()) forgetSecret(value);
    this.#cache.clear();
    this.#lastUseEvent.clear();
  }
  private emitUse(providerKeyId: string): void {
    const now = Date.now();
    if (now - (this.#lastUseEvent.get(providerKeyId) ?? 0) < 60_000) return;
    this.#lastUseEvent.set(providerKeyId, now);
    this.onEvent?.({
      kind: 'use',
      providerId: providerKeyId.split(':')[0] ?? providerKeyId,
      keyId: providerKeyId,
    });
  }
  /** Retrieves a provider's keys through the Vault list RPC and remembers them for redaction. */
  async listProviderSecrets(
    providerId?: string,
  ): Promise<{ id: string; providerId: string; keyId: string; label: string; secret: string }[]> {
    if (!this.isSignedIn()) return [];
    const { data, error } = (await this.client
      .schema(this.schema)
      .rpc('list_provider_key_secrets', { p_provider_id: providerId ?? null })) as {
      data: unknown;
      error: { message: string } | null;
    };
    if (error) throw new Error(`Cloud key list failed: ${friendlyAuthError(error.message)}`);
    if (!Array.isArray(data)) return [];
    return data.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      if (
        typeof row.id !== 'string' ||
        typeof row.provider_id !== 'string' ||
        typeof row.key_id !== 'string' ||
        typeof row.secret !== 'string'
      )
        return [];
      const previous = this.#cache.get(row.id);
      if (previous && previous !== row.secret) forgetSecret(previous);
      this.#cache.set(row.id, row.secret);
      if (!isKnownSecret(row.secret)) rememberSecret(row.secret);
      this.emitUse(row.id);
      return [
        {
          id: row.id,
          providerId: row.provider_id,
          keyId: row.key_id,
          label: typeof row.label === 'string' ? row.label : row.key_id,
          secret: row.secret,
        },
      ];
    });
  }
}
