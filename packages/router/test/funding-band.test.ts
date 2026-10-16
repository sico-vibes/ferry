import { describe, expect, it } from 'vitest';
import { ModelInfoSchema, ProviderSchema, type ModelInfo, type Provider } from '@ferry/shared';
import {
  BUILTIN_PROFILES,
  isIncludedSubscriptionCli,
  scoreModels,
  type CapacityView,
} from '../src/index.js';

const now = '2026-09-27T12:00:00.000Z';
const autoFree = (() => {
  const found = BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free');
  if (!found) throw new Error('missing Auto-Free profile');
  return found;
})();

function apiProvider(id: string): Provider {
  return ProviderSchema.parse({
    id,
    name: id,
    tag: 'legit',
    kind: 'api',
    brand: null,
    keyStatus: 'valid',
    enabled: true,
    health: 'ok',
    cooldownUntil: null,
    dataUse: null,
    termsNote: null,
    signupUrl: null,
    docsUrl: null,
    verifiedAt: null,
    modelCount: 1,
    windows: [],
    stepsLeftToday: null,
  });
}

function cliProvider(id: string): Provider {
  return ProviderSchema.parse({
    id,
    name: id,
    tag: 'subscription_cli',
    kind: 'cli',
    keyRequired: false,
    brand: null,
    keyStatus: 'not_applicable',
    enabled: true,
    health: 'ok',
    cooldownUntil: null,
    dataUse: null,
    termsNote: null,
    signupUrl: null,
    docsUrl: null,
    verifiedAt: null,
    modelCount: 2,
    windows: [],
    stepsLeftToday: null,
  });
}

function apiModel(id: string, free: boolean): ModelInfo {
  return ModelInfoSchema.parse({
    ref: `${id}/model`,
    providerId: id,
    name: `${id} model`,
    tier: 'T2',
    contextWindow: 100_000,
    maxOutput: 4_000,
    toolCalling: true,
    reasoning: false,
    free,
    priceInPerM: free ? 0 : null,
    priceOutPerM: free ? 0 : null,
  });
}

function cliModel(
  providerId: string,
  upstreamId: string,
  billing: 'free' | 'included_subscription',
): ModelInfo {
  return ModelInfoSchema.parse({
    ref: `${providerId}/${upstreamId}`,
    providerId,
    name: upstreamId,
    tier: 'T2',
    contextWindow: 100_000,
    maxOutput: 4_000,
    toolCalling: true,
    reasoning: false,
    free: billing === 'free',
    priceInPerM: null,
    priceOutPerM: null,
    transport: 'codex_cli',
    cliConnectionId: providerId,
    cliCapabilities: {
      ref: `${providerId}/${upstreamId}`,
      connectionId: providerId,
      providerId,
      upstreamId,
      upstreamProvider: null,
      name: upstreamId,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
      speeds: ['standard', 'fast'],
      defaultSpeed: 'standard',
      modalities: ['text'],
      toolCalling: true,
      billing,
      hidden: false,
    },
  });
}

const freeApi = apiModel('gemini', true);
const paidApi = apiModel('deepseek', false);
const freeCli = cliModel('codex-cli', 'free-a', 'free');
const includedCli = cliModel('codex-cli', 'inc-a', 'included_subscription');

const capacity: CapacityView = {
  providers: [apiProvider('gemini'), apiProvider('deepseek'), cliProvider('codex-cli')],
  now,
};

function score(models: ModelInfo[], allowIncludedSubscription: boolean) {
  return scoreModels({
    models,
    providers: capacity.providers,
    capacity,
    profile: autoFree,
    step: 'plan',
    estimate: { inputTokens: 1, requiresTools: true },
    allowIncludedSubscription,
  }).map((candidate) => String(candidate.ref));
}

describe('installed-CLI funding band', () => {
  it('identifies only Included-subscription CLI routes as sponsored', () => {
    expect(isIncludedSubscriptionCli(cliProvider('codex-cli'), freeCli)).toBe(false);
    expect(isIncludedSubscriptionCli(cliProvider('codex-cli'), includedCli)).toBe(true);
    expect(isIncludedSubscriptionCli(apiProvider('gemini'), freeApi)).toBe(false);
  });

  it('recognizes a genuinely free CLI route as free without an opt-in', () => {
    expect(score([freeCli], false)).toEqual(['codex-cli/free-a']);
  });

  it('admits Included CLI only with the profile opt-in and never before a free route', () => {
    // Without the opt-in the Included route is not a candidate at all.
    expect(score([freeApi, freeCli, includedCli], false)).not.toContain('codex-cli/inc-a');
    // With the opt-in it is admitted, but a free API and a free CLI route both come first.
    const ranked = score([freeApi, includedCli], true);
    expect(ranked).toEqual(['gemini/model', 'codex-cli/inc-a']);
    const both = score([includedCli, freeCli, freeApi], true);
    expect(both.indexOf('codex-cli/inc-a')).toBeGreaterThan(both.indexOf('gemini/model'));
    expect(both.indexOf('codex-cli/inc-a')).toBeGreaterThan(both.indexOf('codex-cli/free-a'));
  });

  it('never treats the opt-in as a blanket paid-API allowance', () => {
    // The sponsored flag only admits subscription CLI capacity; a paid API model stays excluded.
    expect(score([paidApi, includedCli], true)).toEqual(['codex-cli/inc-a']);
    expect(score([paidApi], true)).toEqual([]);
  });
});
