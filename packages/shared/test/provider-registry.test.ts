import { expect, it } from 'vitest';
import {
  PROVIDER_REGISTRY,
  canonicalProviderId,
  oauthConnectionId,
  providerDefinition,
} from '../src/provider-registry.js';

it('has unique typed identities and explicit auth, transport, discovery and evidence', () => {
  expect(new Set(PROVIDER_REGISTRY.map((provider) => provider.id)).size).toBe(
    PROVIDER_REGISTRY.length,
  );
  for (const provider of PROVIDER_REGISTRY) {
    expect(provider.docsSource).toMatch(/^https:\/\//);
    expect(provider.capabilities.text).toBe(true);
    expect(['Verified', 'Beta', 'Coming soon']).toContain(provider.releaseState);
  }
  expect(canonicalProviderId('opencode-zen')).toBe('opencode');
  expect(providerDefinition('opencode-zen')).toBe(providerDefinition('opencode'));
  expect(providerDefinition('ollama')?.auth).toBe('local');
  expect(providerDefinition('llm7')?.auth).toBe('anonymous');
  expect(providerDefinition('oauth-qoder')?.releaseState).toBe('Coming soon');
  expect(oauthConnectionId('anthropic')).not.toBe('anthropic');
  expect(providerDefinition('anthropic')?.auth).toBe('api_key');
  expect(providerDefinition(oauthConnectionId('anthropic'))?.auth).toBe('oauth');
});
