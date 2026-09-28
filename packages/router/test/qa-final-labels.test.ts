import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_SETTINGS,
  ModelInfoSchema,
  ProviderIdSchema,
  ProviderSchema,
  type FallbackChainEntry,
  type ModelInfo,
  type Profile,
  type Provider,
} from '@ferry/shared';
import {
  BUILTIN_PROFILES,
  chainForProfile,
  mayUsePromptsForTraining,
  resolveFallbackChain,
  scoreModels,
  type CapacityView,
} from '../src/index.js';

const now = '2026-09-27T12:00:00.000Z';

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return ProviderSchema.parse({
    id: ProviderIdSchema.parse(id),
    name: id,
    tag: 'legit',
    kind: 'api',
    brand: null,
    keyStatus: 'valid',
    keyRequired: true,
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
    stepsLeftToday: 50,
    ...overrides,
  });
}

function model(ref: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  const providerId = ref.slice(0, ref.indexOf('/'));
  return ModelInfoSchema.parse({
    ref,
    providerId,
    name: ref,
    tier: 'T2',
    contextWindow: 100_000,
    maxOutput: 4_000,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
    ...overrides,
  });
}

function builtinProfile(name: string): Profile {
  const found = BUILTIN_PROFILES.find((profile) => profile.name === name);
  if (!found) throw new Error(`missing profile ${name}`);
  return found;
}
const autoFree = builtinProfile('Auto-Free');

function score(profile: Profile, models: ModelInfo[], providers: Provider[], routing = {}) {
  const capacity: CapacityView = { providers, now };
  return scoreModels({
    models,
    capacity,
    profile,
    step: 'plan',
    estimate: { inputTokens: 100, requiresTools: true },
    routing: { ...DEFAULT_ROUTING_SETTINGS, ...routing },
  });
}

describe('QA final: data-use training opt-out detection', () => {
  it.fails(
    'treats explicit negation phrasing as not-training even when a train/improve verb appears',
    () => {
      // BUG: mayUsePromptsForTraining only recognizes a few exact negations
      // ("not used for training", "not train", "no training", "zero data
      // retention"). A provider that says "data is not used to train" or "we
      // never train" still matches the bare `\b(?:train|training|improve)\b`
      // branch and is wrongly flagged as a training provider, so enabling
      // avoid-training excludes a safe provider.
      expect(mayUsePromptsForTraining('Your data is not used to train our models.')).toBe(false);
      expect(mayUsePromptsForTraining('We never train on customer prompts.')).toBe(false);
      expect(mayUsePromptsForTraining('We do not use prompts to improve our models.')).toBe(false);
    },
  );

  it('flags a provider that admits it improves products from unpaid requests', () => {
    expect(
      mayUsePromptsForTraining('Requests may be used to improve Google products on unpaid tier.'),
    ).toBe(true);
    expect(mayUsePromptsForTraining(null)).toBe(false);
    expect(mayUsePromptsForTraining(undefined)).toBe(false);
    expect(mayUsePromptsForTraining('Zero Data Retention; prompts are not stored.')).toBe(false);
  });
});

describe('QA final: avoid-training routing', () => {
  const training = provider('gemini', {
    dataUse: 'Requests may be used to improve Google products on unpaid tier.',
  });
  const safe = provider('groq', { dataUse: 'Subject to Groq terms.' });
  const models = [model('gemini/gemini-3.8-flash'), model('groq/qwen/qwen3.8-27b')];

  it('excludes a training provider from scored candidates when the toggle is on and keeps it when off', () => {
    const off = score(autoFree, models, [training, safe], { avoidTrainingProviders: false });
    expect(off.map((candidate) => candidate.ref)).toContain('gemini/gemini-3.8-flash');
    const on = score(autoFree, models, [training, safe], { avoidTrainingProviders: true });
    expect(on.map((candidate) => candidate.ref)).toEqual(['groq/qwen/qwen3.8-27b']);
  });

  it('excludes a training provider from an explicit fallback chain when avoided', () => {
    const chain: FallbackChainEntry[] = [
      { provider: ProviderIdSchema.parse('gemini'), patterns: ['gemini-3.8-flash'] },
      { provider: ProviderIdSchema.parse('groq'), patterns: ['qwen/qwen3.8-27b'] },
    ];
    const capacity: CapacityView = { providers: [training, safe], now };
    const result = resolveFallbackChain({
      chain,
      models,
      capacity,
      profile: autoFree,
      inputTokens: 100,
      step: 'plan',
      avoidTrainingProviders: true,
    });
    expect(result.models.map((candidate) => candidate.ref)).toEqual(['groq/qwen/qwen3.8-27b']);
    expect(
      result.diagnostics.some((row) => row.provider === 'gemini' && row.status === 'ineligible'),
    ).toBe(true);
  });
});

describe('QA final: provider labels and free routing', () => {
  it.fails(
    'does not send Auto-Free traffic to a trial/credits-only provider without opt-in',
    () => {
      // BUG: isFreeForRouting falls through to `model.free` for tag 'trial', so
      // Auto-Free routes to the Cerebras free trial (a finite, credits-only
      // trial) with no opt-in, even though the eval harness and the label
      // semantics require trial providers to be explicitly included.
      const trial = provider('cerebras', {
        tag: 'trial',
        dataUse: 'Subject to Cerebras terms.',
      });
      const candidates = score(autoFree, [model('cerebras/gpt-oss-120b')], [trial]);
      expect(candidates).toHaveLength(0);
    },
  );

  it('keeps a promo provider routable for Auto-Free even when models.dev marks it paid', () => {
    const promo = provider('novita', { tag: 'promo' });
    const candidates = score(
      autoFree,
      [
        model('novita/llama-3.3-70b-instruct', {
          free: false,
          priceInPerM: 0.2,
          priceOutPerM: 0.4,
        }),
      ],
      [promo],
    );
    expect(candidates.map((candidate) => candidate.ref)).toEqual(['novita/llama-3.3-70b-instruct']);
    expect(candidates[0]?.scoreBreakdown?.cost).toBe(6);
  });

  it('built-in profile roles default to on only for Auto-Free and Best Available', () => {
    expect(chainForProfile(builtinProfile('Auto-Free')).length).toBeGreaterThan(0);
    expect(chainForProfile(builtinProfile('Best Available')).length).toBeGreaterThan(0);
    expect(chainForProfile(builtinProfile('Fast'))).toEqual([]);
    expect(builtinProfile('Auto-Free').roles.enabled).toBe(true);
    expect(builtinProfile('Best Available').roles.enabled).toBe(true);
    expect(builtinProfile('Fast').roles.enabled).toBe(false);
    expect(builtinProfile('Long Context').roles.enabled).toBe(false);
  });
});
