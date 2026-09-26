import { describe, expect, it } from 'vitest';
import { ProviderSchema } from '@ferry/shared';
import { createSessionDependencies } from '../src/session-deps.js';
import { startHarness } from './qa-w3-harness.js';

describe('subscription OAuth routing', () => {
  it('keeps OAuth models out of automatic candidates until the routing setting is enabled', async () => {
    const harness = await startHarness();
    try {
      harness.services.providers.put(
        ProviderSchema.parse({
          id: 'anthropic',
          name: 'Anthropic Claude Pro/Max',
          tag: 'subscription_oauth',
          kind: 'api',
          brand: null,
          keyStatus: 'valid',
          enabled: true,
          health: 'ok',
          cooldownUntil: null,
          dataUse: null,
          termsNote: 'Unofficial; account suspension risk',
          signupUrl: null,
          docsUrl: null,
          verifiedAt: null,
          modelCount: 2,
          windows: [],
          stepsLeftToday: null,
        }),
      );
      const best = (await harness.rpc.profiles.list()).find(
        (profile) => profile.name === 'Best Available',
      );
      if (!best) throw new Error('Best Available profile is missing');
      const gateway = createSessionDependencies(harness.services, () => undefined).gateway;
      const before = gateway.resolveCandidates(best, 'search');
      expect(before.some((model) => model.providerId === 'anthropic')).toBe(false);
      await harness.rpc.settings.update({ allowSubscriptionOAuthRouting: true });
      const after = gateway.resolveCandidates(best, 'search');
      expect(after.some((model) => model.providerId === 'anthropic')).toBe(true);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
