import { describe, expect, it } from 'vitest';
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { MemorySecretStore } from '@ferry/secrets';
import { isKnownSecret, redactKnownSecretText } from '@ferry/shared';
import { FakeProviderServer } from '@ferry/testkit';
import {
  listOAuthProviders,
  discoverOAuthFlowExports,
  refreshWithAuth,
  startLoginWithAuth,
  validateRadiusGatewayUrl,
} from '../src/index.js';
import type { OAuthLoginEvent } from '../src/index.js';

describe('subscription OAuth lifecycle', () => {
  it('derives provider ids from the installed pi-ai loader export map', () => {
    const fakeModuleMap: Record<string, unknown> = {
      loadAnthropicOAuth: () => Promise.resolve({}),
      loadOpenAICodexOAuth: () => Promise.resolve({}),
      loadFutureProviderOAuth: () => Promise.resolve({}),
      notAnOAuthLoader: () => Promise.resolve({}),
    };
    expect([...discoverOAuthFlowExports(fakeModuleMap).keys()]).toEqual([
      'anthropic',
      'openai-codex',
      'future-provider',
    ]);
  });

  it('lists the OAuth flows and models exported by this installed pi-ai version', async () => {
    const providers = await listOAuthProviders();
    expect(providers.map((provider) => provider.id)).toEqual([
      'anthropic',
      'openai-codex',
      'github-copilot',
      'openrouter',
      'kimi-coding',
      'meta',
      'xai',
      'radius',
    ]);
    expect(providers.find((provider) => provider.id === 'openrouter')).toMatchObject({
      tag: 'legit',
      riskLevel: 'low',
      group: 'official',
      subscriptionRequired: false,
    });
    expect(
      providers
        .filter((provider) => provider.group === 'subscription')
        .every(
          (provider) => provider.riskLevel === 'high' && provider.riskText.includes('suspension'),
        ),
    ).toBe(true);
    expect(providers.find((provider) => provider.id === 'radius')).toMatchObject({
      advanced: true,
      riskLevel: 'medium',
      models: [],
    });
    expect(
      providers
        .filter((provider) => provider.id !== 'radius')
        .every((provider) => provider.models.length > 0),
    ).toBe(true);
  });

  it('stores the OpenRouter OAuth result as a normal API key', async () => {
    const store = new MemorySecretStore('openrouter-oauth-test');
    const auth: OAuthAuth = {
      name: 'OpenRouter OAuth',
      isSubscription: false,
      login() {
        return Promise.resolve({
          access: 'sk-or-user-key',
          refresh: '',
          expires: Number.MAX_SAFE_INTEGER,
          type: 'oauth',
        });
      },
      refresh(credential) {
        return Promise.resolve(credential);
      },
      toAuth(credential) {
        return Promise.resolve({ apiKey: credential.access });
      },
    };
    try {
      await startLoginWithAuth(
        'openrouter',
        auth,
        {
          openUrl: () => undefined,
          onDeviceCode: () => undefined,
        },
        store,
      );
      expect(await store.get('openrouter')).toBe('sk-or-user-key');
      expect(await store.get('oauth:openrouter')).toBeUndefined();
    } finally {
      store.clear();
    }
  });

  it('validates Radius gateway URLs and rejects embedded credentials', () => {
    expect(validateRadiusGatewayUrl('https://radius.example/')).toBe('https://radius.example/');
    expect(() => validateRadiusGatewayUrl('file:///tmp/gateway')).toThrow(/HTTP\(S\)/);
    expect(() => validateRadiusGatewayUrl('https://user:password@radius.example')).toThrow(
      /credentials/,
    );
  });

  it('uses a fake token server, refreshes expired credentials, and keeps tokens out of events', async () => {
    const server = new FakeProviderServer({
      responses: [
        {
          body: {
            access: 'expired-access-secret',
            refresh: 'old-refresh-secret',
            expires: Date.now() - 1,
          },
        },
        {
          body: {
            access: 'fresh-access-secret',
            refresh: 'fresh-refresh-secret',
            expires: Date.now() + 3_600_000,
          },
        },
      ],
    });
    await server.start();
    const endpoint = `${server.baseUrl}/token`;
    const store = new MemorySecretStore('oauth-test');
    const events: OAuthLoginEvent[] = [];
    const fakeAuth: OAuthAuth = {
      name: 'Fake subscription',
      isSubscription: true,
      async login(interaction) {
        expect(
          await interaction.prompt({
            type: 'select',
            message: 'Choose login method',
            options: [
              { id: 'browser', label: 'Browser' },
              { id: 'device', label: 'Device code' },
            ],
          }),
        ).toBe('browser');
        expect(await interaction.prompt({ type: 'text', message: 'Enterprise URL' })).toBe('');
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://login.example.test',
          expiresInSeconds: 300,
        });
        const response = await fetch(endpoint, { method: 'POST' });
        const tokens = (await response.json()) as {
          access: string;
          refresh: string;
          expires: number;
        };
        return { ...tokens, type: 'oauth' };
      },
      async refresh(_credential, signal) {
        const response = await fetch(endpoint, { method: 'POST', signal });
        return {
          ...((await response.json()) as { access: string; refresh: string; expires: number }),
          type: 'oauth',
        };
      },
      toAuth(credential) {
        return Promise.resolve({ apiKey: credential.access });
      },
    };
    try {
      await startLoginWithAuth(
        'anthropic',
        fakeAuth,
        {
          openUrl: () => undefined,
          onDeviceCode: () => undefined,
          onProgress: (event) => {
            events.push(event);
          },
        },
        store,
      );
      const saved = JSON.parse((await store.get('oauth:anthropic')) ?? 'null') as OAuthCredential;
      expect(saved.access).toBe('expired-access-secret');
      expect(isKnownSecret(saved.access)).toBe(true);
      expect(isKnownSecret(saved.refresh)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(saved.access);
      expect(JSON.stringify(events)).not.toContain(saved.refresh);
      expect(redactKnownSecretText(`access=${saved.access}`)).toBe('access=[REDACTED]');

      const updated = await refreshWithAuth('anthropic', fakeAuth, store);
      expect(updated.expires).toBeGreaterThan(Date.now());
      expect(updated.access).toBe('fresh-access-secret');
      expect(isKnownSecret(saved.access)).toBe(false);
      expect(events.at(-1)?.type).toBe('success');
    } finally {
      store.clear();
      await server.stop();
    }
  }, 30_000);
});
