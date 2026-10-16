import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliTransportError } from '@ferry/delegate';
import { MemorySecretStore } from '@ferry/secrets';
import { isKnownSecret, redactKnownSecretText, type CliModelCapabilities } from '@ferry/shared';
import type { ProviderKeyEntry } from '@ferry/storage';
import {
  openCodeCredentialOffer,
  resolveOpenCodeCredential,
  type OpenCodeCredentialEvidence,
} from '../src/cli-opencode-credentials.js';
import { createServices, type FerryServices } from '../src/services.js';

vi.setConfig({ testTimeout: 30_000 });

type OpenCodeModel = Pick<CliModelCapabilities, 'upstreamProvider' | 'billing'>;

let root: string;
let dataDir: string;
let xdgHome: string;
let authPath: string;
let services: FerryServices;
let secrets: MemorySecretStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferry-oc-cred-'));
  dataDir = join(root, 'data');
  xdgHome = join(root, 'xdg');
  authPath = join(xdgHome, 'opencode', 'auth.json');
  await mkdir(join(xdgHome, 'opencode'), { recursive: true });
  secrets = new MemorySecretStore('oc-cred');
  services = await createServices({
    dataDir,
    env: { ...process.env, XDG_DATA_HOME: xdgHome, NODE_ENV: 'test' },
    secrets,
  });
});

afterAll(async () => {
  await services.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

beforeEach(async () => {
  services.db.client.exec('DELETE FROM provider_key_entries; DELETE FROM provider_keys;');
  secrets.clear();
  delete services.env.OPENCODE_API_KEY;
  await rm(authPath, { force: true });
  services.settings.put('global', { cliConnections: {} });
});

function model(overrides: Partial<OpenCodeModel> = {}): OpenCodeModel {
  return { upstreamProvider: 'opencode', billing: 'free', ...overrides };
}

function setConnection(mode: 'installed' | 'anonymous' | 'ferry', provider: string | null): void {
  services.settings.put('global', {
    cliConnections: {
      'opencode-cli': { credentialMode: mode, credentialProvider: provider },
    },
  });
}

async function writeAuth(record: Record<string, unknown>): Promise<void> {
  await writeFile(authPath, JSON.stringify(record), 'utf8');
}

function entry(overrides: Partial<ProviderKeyEntry> & { providerId: string }): ProviderKeyEntry {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: `${overrides.providerId}:1`,
    keyId: '1',
    label: 'Key',
    position: 0,
    enabled: true,
    status: 'ok',
    lastError: null,
    cooldownUntil: null,
    keyringRef: overrides.providerId,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('resolveOpenCodeCredential', () => {
  it('fingerprints the native Zen env credential without returning it', async () => {
    setConnection('installed', null);
    services.env.OPENCODE_API_KEY = 'zen-env-secret';
    const evidence = await resolveOpenCodeCredential(services, model());
    expect(evidence.mode).toBe('installed');
    expect(evidence.provider).toBe('opencode');
    expect(evidence.credentialProvider).toBeNull();
    expect(evidence.apiKey).toBeUndefined();
    expect(evidence.accountKey).toMatch(/^opencode-cli:[a-f0-9]{24}$/);
    expect(evidence.accountKey).not.toContain('zen-env-secret');
    const again = await resolveOpenCodeCredential(services, model());
    expect(again.accountKey).toBe(evidence.accountKey);
  });

  it('lets an installed Zen api key win over OPENCODE_API_KEY (verified native precedence)', async () => {
    setConnection('installed', null);
    await writeAuth({ opencode: { type: 'api', key: 'store-secret' } });
    services.env.OPENCODE_API_KEY = 'env-secret';
    const fromStore = await resolveOpenCodeCredential(services, model());

    // The same key read from the env variable alone yields the same fingerprint; if the env key had
    // won, this identity would instead be the env-secret identity.
    await rm(authPath, { force: true });
    services.env.OPENCODE_API_KEY = 'store-secret';
    const envKey = await resolveOpenCodeCredential(services, model());
    expect(fromStore.accountKey).toBe(envKey.accountKey);

    await rm(authPath, { force: true });
    services.env.OPENCODE_API_KEY = 'env-secret';
    const envOnly = await resolveOpenCodeCredential(services, model());
    expect(envOnly.accountKey).not.toBe(fromStore.accountKey);
  });

  it('applies OPENCODE_API_KEY to the two OpenCode providers but never to an unrelated provider', async () => {
    setConnection('installed', null);
    services.env.OPENCODE_API_KEY = 'shared-opencode-key';
    const zen = await resolveOpenCodeCredential(services, model());
    const go = await resolveOpenCodeCredential(
      services,
      model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
    );
    expect(zen.accountKey).not.toBeNull();
    expect(go.accountKey).not.toBeNull();
    // Same key, different provider domain => distinct identities, but both are covered by the env.
    expect(go.accountKey).not.toBe(zen.accountKey);

    // An unrelated provider never inherits the OpenCode env key.
    const unrelated = await resolveOpenCodeCredential(
      services,
      model({ upstreamProvider: 'anthropic', billing: 'metered' }),
    );
    expect(unrelated.accountKey).toBeNull();
    expect(unrelated.apiKey).toBeUndefined();

    // A Go api store key still wins over the shared env key.
    await writeAuth({ 'opencode-go': { type: 'api', key: 'go-store-secret' } });
    const goStore = await resolveOpenCodeCredential(
      services,
      model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
    );
    expect(goStore.accountKey).not.toBe(go.accountKey);
  });

  it('maps the approved Go offer onto a Zen model without proving Zen entitlement', async () => {
    setConnection('installed', 'opencode-go');
    await writeAuth({ 'opencode-go': { type: 'api', key: 'go-secret' } });
    const evidence = await resolveOpenCodeCredential(services, model());
    expect(evidence.mode).toBe('installed');
    expect(evidence.provider).toBe('opencode');
    expect(evidence.credentialProvider).toBe('opencode-go');
    expect(evidence.apiKey).toBe('go-secret');
    expect(evidence.accountKey).toMatch(/^opencode-cli:[a-f0-9]{24}$/);
    expect(evidence.accountKey).not.toContain('go-secret');
    // The same key resolves to a different identity under Zen; the Go offer is not a Zen receipt.
    services.env.OPENCODE_API_KEY = 'go-secret';
    setConnection('installed', null);
    const zenSameKey = await resolveOpenCodeCredential(services, model());
    expect(zenSameKey.accountKey).not.toBe(evidence.accountKey);
  });

  it('binds the approved Go offer to the Go key even when Zen A and env C are installed', async () => {
    setConnection('installed', 'opencode-go');
    services.env.OPENCODE_API_KEY = 'env-C';
    await writeAuth({
      opencode: { type: 'api', key: 'zen-A' },
      'opencode-go': { type: 'api', key: 'go-B' },
    });
    const evidence = await resolveOpenCodeCredential(services, model());
    expect(evidence.provider).toBe('opencode');
    expect(evidence.credentialProvider).toBe('opencode-go');
    expect(evidence.apiKey).toBe('go-B');
    // Identical to a Go-native read of the offered key (same provider+key domain)...
    services.env.OPENCODE_API_KEY = '';
    setConnection('installed', null);
    const goNative = await resolveOpenCodeCredential(
      services,
      model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
    );
    expect(goNative.accountKey).toBe(evidence.accountKey);
    // ...and distinct from the Zen A identity, so the offered Go key is not a Zen receipt.
    const zenNative = await resolveOpenCodeCredential(services, model());
    expect(zenNative.accountKey).not.toBe(evidence.accountKey);
  });

  it('keeps a same-provider selection native-owned for the Go provider', async () => {
    setConnection('installed', 'opencode-go');
    await writeAuth({ 'opencode-go': { type: 'api', key: 'go-native-secret' } });
    const evidence = await resolveOpenCodeCredential(
      services,
      model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
    );
    expect(evidence.credentialProvider).toBe('opencode-go');
    expect(evidence.provider).toBe('opencode-go');
    expect(evidence.apiKey).toBeUndefined();
    expect(evidence.accountKey).not.toBeNull();
  });

  it('rejects an unapproved cross-provider offer before reading any key', async () => {
    const entries = vi.spyOn(services.providerKeyEntries, 'list');
    const secretGet = vi.spyOn(services.secrets, 'get');
    try {
      await writeAuth({ anthropic: { type: 'api', key: 'anthropic-secret' } });

      setConnection('installed', 'anthropic');
      await expect(resolveOpenCodeCredential(services, model())).rejects.toMatchObject({
        kind: 'unsupported_capability',
      });

      // Go model receiving a Zen offer is also not approved.
      setConnection('installed', 'opencode');
      await expect(
        resolveOpenCodeCredential(
          services,
          model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
        ),
      ).rejects.toMatchObject({ kind: 'unsupported_capability' });

      // Even with a readable key present, nothing is read.
      setConnection('installed', 'anthropic');
      await expect(resolveOpenCodeCredential(services, model())).rejects.toMatchObject({
        kind: 'unsupported_capability',
      });
      expect(entries).not.toHaveBeenCalled();
      expect(secretGet).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
      secretGet.mockRestore();
    }
  });

  it('isolates Zen and Go identities and rotates only on the selected provider key change', async () => {
    setConnection('installed', null);
    await writeAuth({
      opencode: { type: 'api', key: 'same-key' },
      'opencode-go': { type: 'api', key: 'same-key' },
      anthropic: { type: 'api', key: 'unrelated-key' },
    });
    const zen = await resolveOpenCodeCredential(services, model());
    const go = await resolveOpenCodeCredential(
      services,
      model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
    );
    expect(zen.accountKey).not.toBeNull();
    expect(go.accountKey).not.toBeNull();
    expect(zen.accountKey).not.toBe(go.accountKey);
  });

  it('changes identity on the selected key rotation but preserves it across unrelated entry changes', async () => {
    setConnection('installed', null);
    await writeAuth({
      opencode: { type: 'api', key: 'a-key' },
      anthropic: { type: 'api', key: 'unrelated-1' },
    });
    const before = await resolveOpenCodeCredential(services, model());

    await writeAuth({
      opencode: { type: 'api', key: 'a-key' },
      anthropic: { type: 'api', key: 'unrelated-2' },
      'opencode-go': { type: 'api', key: 'go-unrelated' },
    });
    const unrelated = await resolveOpenCodeCredential(services, model());
    expect(unrelated.accountKey).toBe(before.accountKey);

    await writeAuth({ opencode: { type: 'api', key: 'b-key' } });
    const rotated = await resolveOpenCodeCredential(services, model());
    expect(rotated.accountKey).not.toBe(before.accountKey);
  });

  it('returns an honest none-state for a malformed or missing auth store', async () => {
    setConnection('installed', null);
    await writeFile(authPath, '{ not json', 'utf8');
    const malformed = await resolveOpenCodeCredential(services, model());
    expect(malformed.mode).toBe('installed');
    expect(malformed.accountKey).toBeNull();
    expect(malformed.apiKey).toBeUndefined();

    await rm(authPath, { force: true });
    const missing = await resolveOpenCodeCredential(services, model());
    expect(missing.accountKey).toBeNull();
    expect(missing.apiKey).toBeUndefined();
  });

  it('resolves anonymous Zen access without reading any secret, key entry or store', async () => {
    setConnection('anonymous', null);
    await writeAuth({ 'opencode-go': { type: 'api', key: 'go-secret' } });
    const secretGet = vi.spyOn(services.secrets, 'get');
    const entries = vi.spyOn(services.providerKeyEntries, 'list');
    const legacy = vi.spyOn(services.providerKeys, 'get');
    try {
      const evidence = await resolveOpenCodeCredential(services, model());
      expect(evidence).toEqual({
        mode: 'anonymous',
        provider: 'opencode',
        credentialProvider: null,
        accountKey: null,
      });
      expect(evidence.apiKey).toBeUndefined();
      expect(secretGet).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      secretGet.mockRestore();
      entries.mockRestore();
      legacy.mockRestore();
    }
  });

  it('rejects anonymous access for a Go model, a paid model, or an explicit provider', async () => {
    setConnection('anonymous', null);
    await expect(
      resolveOpenCodeCredential(
        services,
        model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
      ),
    ).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await expect(
      resolveOpenCodeCredential(services, model({ billing: 'metered' })),
    ).rejects.toMatchObject({ kind: 'unsupported_capability' });
    setConnection('anonymous', 'opencode-go');
    await expect(resolveOpenCodeCredential(services, model())).rejects.toMatchObject({
      kind: 'authentication',
    });
  });

  it('returns the saved Zen ferry key and registers it with redaction', async () => {
    setConnection('ferry', null);
    const secret = 'ferry-zen-secret-1234567890';
    services.providerKeyEntries.put(entry({ providerId: 'opencode' }));
    await services.secrets.set('opencode', secret);
    const evidence = await resolveOpenCodeCredential(services, model());
    expect(evidence.mode).toBe('ferry');
    expect(evidence.provider).toBe('opencode');
    expect(evidence.apiKey).toBe(secret);
    expect(evidence.accountKey).toMatch(/^opencode-cli:[a-f0-9]{24}$/);
    expect(evidence.accountKey).not.toContain(secret);
    expect(isKnownSecret(secret)).toBe(true);
    expect(redactKnownSecretText(`leak ${secret} end`)).toBe('leak [REDACTED] end');
  });

  it('registers read native key material with redaction without returning it', async () => {
    setConnection('installed', null);
    const secret = 'native-remember-secret-1234567890';
    await writeAuth({ opencode: { type: 'api', key: secret } });
    const evidence = await resolveOpenCodeCredential(services, model());
    expect(evidence.apiKey).toBeUndefined();
    expect(isKnownSecret(secret)).toBe(true);
    expect(redactKnownSecretText(`x ${secret} y`)).toContain('[REDACTED]');
  });

  it('is Zen-only in ferry mode and never reads Go or third-party key entries', async () => {
    setConnection('ferry', null);
    const entries = vi.spyOn(services.providerKeyEntries, 'list');
    const secretGet = vi.spyOn(services.secrets, 'get');
    try {
      await expect(
        resolveOpenCodeCredential(
          services,
          model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
        ),
      ).rejects.toMatchObject({ kind: 'unsupported_capability' });
      // A Go offer is not silently remapped onto the Zen key.
      setConnection('ferry', 'opencode-go');
      await expect(resolveOpenCodeCredential(services, model())).rejects.toMatchObject({
        kind: 'unsupported_capability',
      });
      expect(entries).not.toHaveBeenCalled();
      expect(secretGet).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
      secretGet.mockRestore();
    }
  });

  it('ferry mode rejects unusable entries instead of falling back to the legacy key', async () => {
    setConnection('ferry', null);
    services.providerKeys.put({
      id: 'opencode',
      providerId: 'opencode',
      keyringRef: 'opencode-legacy',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await services.secrets.set('opencode-legacy', 'legacy-secret');
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();

    const unusable: Partial<ProviderKeyEntry>[] = [
      { status: 'ok', cooldownUntil: future },
      { enabled: false, status: 'disabled', cooldownUntil: past },
      { status: 'invalid', cooldownUntil: null },
      { status: 'rate_limited', cooldownUntil: future },
      { status: 'ok', cooldownUntil: 'not-a-date' },
    ];
    for (const overrides of unusable) {
      services.providerKeyEntries.put(entry({ providerId: 'opencode', ...overrides }));
      await expect(resolveOpenCodeCredential(services, model())).rejects.toBeInstanceOf(
        CliTransportError,
      );
    }
  });

  it('ferry mode accepts an entry whose cooldown has elapsed', async () => {
    setConnection('ferry', null);
    services.providerKeyEntries.put(
      entry({
        providerId: 'opencode',
        status: 'rate_limited',
        cooldownUntil: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    await services.secrets.set('opencode', 'ok-secret');
    const evidence = await resolveOpenCodeCredential(services, model());
    expect(evidence.apiKey).toBe('ok-secret');
  });

  it('ferry mode preserves the legacy provider reference when there are no entries', async () => {
    setConnection('ferry', null);
    services.providerKeys.put({
      id: 'opencode',
      providerId: 'opencode',
      keyringRef: 'legacy-ref',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await services.secrets.set('legacy-ref', 'legacy-value');
    const evidence = await resolveOpenCodeCredential(services, model());
    expect(evidence.apiKey).toBe('legacy-value');
    expect(evidence.accountKey).not.toContain('legacy-value');
  });

  it('ferry mode rejects when no saved key exists at all', async () => {
    setConnection('ferry', null);
    await expect(resolveOpenCodeCredential(services, model())).rejects.toMatchObject({
      kind: 'authentication',
    });
  });

  it('wraps a secret-store read failure in a redacted typed error', async () => {
    setConnection('ferry', null);
    services.providerKeyEntries.put(entry({ providerId: 'opencode' }));
    const secretGet = vi
      .spyOn(services.secrets, 'get')
      .mockRejectedValue(new Error('keyring backend unavailable at C:\\secret\\path'));
    try {
      let thrown: unknown;
      try {
        await resolveOpenCodeCredential(services, model());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliTransportError);
      expect((thrown as CliTransportError).kind).toBe('authentication');
      const message = (thrown as CliTransportError).message;
      // Never surface the keyring reference or the storage error content.
      expect(message).not.toContain('keyring backend unavailable');
      expect(message).not.toContain('C:\\secret\\path');
      expect(message).not.toContain('opencode');
    } finally {
      secretGet.mockRestore();
    }
  });

  it('rejects an explicit different provider without silently falling back', async () => {
    setConnection('installed', 'anthropic');
    await writeAuth({ opencode: { type: 'api', key: 'zen-secret' } });
    let thrown: unknown;
    try {
      await resolveOpenCodeCredential(services, model());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliTransportError);
    expect((thrown as CliTransportError).kind).toBe('unsupported_capability');
    expect((thrown as CliTransportError).message).not.toContain('zen-secret');
  });

  it('never treats OAuth or unknown-type records as API credentials', async () => {
    setConnection('installed', null);
    // An OAuth record carrying a stray key must not become an API credential or prove presence.
    await writeAuth({
      'opencode-go': { type: 'oauth', key: 'oauth-stray-key', refresh: 'r', access: 'a' },
    });
    const oauthSame = await resolveOpenCodeCredential(
      services,
      model({ upstreamProvider: 'opencode-go', billing: 'included_subscription' }),
    );
    expect(oauthSame.accountKey).toBeNull();
    expect(oauthSame.apiKey).toBeUndefined();
    expect(JSON.stringify(oauthSame)).not.toContain('oauth-stray-key');
    expect(JSON.stringify(oauthSame)).not.toContain('refresh');

    // An unknown type with a key is not an API credential, and a bare `api` record with no key is
    // not a usable credential either.
    await writeAuth({ opencode: { type: 'wellknown', key: 'unknown-type-key' } });
    const unknownSame = await resolveOpenCodeCredential(services, model());
    expect(unknownSame.accountKey).toBeNull();
    expect(unknownSame.apiKey).toBeUndefined();
    await writeAuth({ opencode: { type: 'api' } });
    const keylessApi = await resolveOpenCodeCredential(services, model());
    expect(keylessApi.accountKey).toBeNull();

    // A cross-provider offer cannot copy either record's material.
    setConnection('installed', 'opencode-go');
    await writeAuth({ 'opencode-go': { type: 'oauth', key: 'oauth-stray-key', refresh: 'r' } });
    await expect(resolveOpenCodeCredential(services, model())).rejects.toMatchObject({
      kind: 'authentication',
    });
  });

  it('rejects a model without an OpenCode upstream provider', async () => {
    await expect(
      resolveOpenCodeCredential(services, { upstreamProvider: null, billing: 'free' }),
    ).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await expect(
      resolveOpenCodeCredential(services, { upstreamProvider: '   ', billing: 'free' }),
    ).rejects.toBeInstanceOf(CliTransportError);
  });

  it('exposes nonsecret offer metadata without the apiKey', () => {
    const evidence: OpenCodeCredentialEvidence = {
      mode: 'ferry',
      provider: 'opencode',
      credentialProvider: 'opencode-go',
      accountKey: 'opencode-cli:abcdef0123456789abcdef01',
      apiKey: 'super-secret',
    };
    const offer = openCodeCredentialOffer(evidence);
    expect(offer).toEqual({
      mode: 'ferry',
      provider: 'opencode',
      credentialProvider: 'opencode-go',
      present: true,
      fingerprint: 'opencode-cli:abcdef0123456789abcdef01',
    });
    expect(JSON.stringify(offer)).not.toContain('super-secret');
    expect(
      openCodeCredentialOffer({
        mode: 'anonymous',
        provider: 'opencode',
        credentialProvider: null,
        accountKey: null,
      }).present,
    ).toBe(false);
  });
});
