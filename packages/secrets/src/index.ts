import { Entry } from '@napi-rs/keyring';

export interface SecretStore {
  set(providerKeyId: string, value: string): Promise<void>;
  get(providerKeyId: string): Promise<string | undefined>;
  delete(providerKeyId: string): Promise<void>;
  has(providerKeyId: string): Promise<boolean>;
}

export class KeyringSecretStore implements SecretStore {
  constructor(private readonly service = 'Ferry') {}
  set(providerKeyId: string, value: string): Promise<void> {
    new Entry(this.service, providerKeyId).setPassword(value);
    return Promise.resolve();
  }
  get(providerKeyId: string): Promise<string | undefined> {
    return Promise.resolve(new Entry(this.service, providerKeyId).getPassword() ?? undefined);
  }
  delete(providerKeyId: string): Promise<void> {
    new Entry(this.service, providerKeyId).deleteCredential();
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
    this.#values.set(this.#key(providerKeyId), value);
    return Promise.resolve();
  }
  get(providerKeyId: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(this.#key(providerKeyId)));
  }
  delete(providerKeyId: string): Promise<void> {
    this.#values.delete(this.#key(providerKeyId));
    return Promise.resolve();
  }
  has(providerKeyId: string): Promise<boolean> {
    return Promise.resolve(this.#values.has(this.#key(providerKeyId)));
  }
  clear(): void {
    this.#values.clear();
  }
}
