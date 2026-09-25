import { Entry } from '@napi-rs/keyring';
import { forgetSecret, isKnownSecret, rememberSecret } from '@ferry/shared';

export interface SecretStore {
  set(providerKeyId: string, value: string): Promise<void>;
  get(providerKeyId: string): Promise<string | undefined>;
  delete(providerKeyId: string): Promise<void>;
  has(providerKeyId: string): Promise<boolean>;
}

export class KeyringSecretStore implements SecretStore {
  constructor(private readonly service = 'Ferry') {}
  set(providerKeyId: string, value: string): Promise<void> {
    const entry = new Entry(this.service, providerKeyId);
    const old = entry.getPassword() ?? undefined;
    entry.setPassword(value);
    if (old !== value) {
      if (old) forgetSecret(old);
      rememberSecret(value);
    }
    return Promise.resolve();
  }
  get(providerKeyId: string): Promise<string | undefined> {
    const value = new Entry(this.service, providerKeyId).getPassword() ?? undefined;
    if (value && !isKnownSecret(value)) rememberSecret(value);
    return Promise.resolve(value);
  }
  delete(providerKeyId: string): Promise<void> {
    const entry = new Entry(this.service, providerKeyId);
    const old = entry.getPassword() ?? undefined;
    entry.deleteCredential();
    if (old) forgetSecret(old);
    return Promise.resolve();
  }
  has(providerKeyId: string): Promise<boolean> {
    return this.get(providerKeyId).then((value) => value !== undefined);
  }
}

export class MemorySecretStore implements SecretStore {
  readonly #values = new Map<string, string>();
  readonly #namespace: string;
  constructor(namespace = 'default') {
    this.#namespace = namespace;
  }
  #key(providerKeyId: string): string {
    return `${this.#namespace}:${providerKeyId}`;
  }
  set(providerKeyId: string, value: string): Promise<void> {
    const key = this.#key(providerKeyId);
    const old = this.#values.get(key);
    this.#values.set(key, value);
    if (old !== value) {
      if (old) forgetSecret(old);
      rememberSecret(value);
    }
    return Promise.resolve();
  }
  get(providerKeyId: string): Promise<string | undefined> {
    const value = this.#values.get(this.#key(providerKeyId));
    if (value && !isKnownSecret(value)) rememberSecret(value);
    return Promise.resolve(value);
  }
  delete(providerKeyId: string): Promise<void> {
    const key = this.#key(providerKeyId);
    const old = this.#values.get(key);
    this.#values.delete(key);
    if (old) forgetSecret(old);
    return Promise.resolve();
  }
  has(providerKeyId: string): Promise<boolean> {
    return Promise.resolve(this.#values.has(this.#key(providerKeyId)));
  }
  clear(): void {
    for (const value of this.#values.values()) forgetSecret(value);
    this.#values.clear();
  }
}
