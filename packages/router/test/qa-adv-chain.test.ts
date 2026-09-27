import { describe, expect, it } from 'vitest';
import {
  ModelInfoSchema,
  ProviderIdSchema,
  ProviderSchema,
  type ModelInfo,
  type Profile,
  type Provider,
} from '@ferry/shared';
import { BUILTIN_PROFILES } from '../src/index.js';
import {
  DEFAULT_AUTO_FREE_CHAIN,
  chainForProfile,
  isStrictFallbackNameEligible,
  resolveFallbackChain,
  type ChainSkipReason,
} from '../src/index.js';
import type { CapacityView } from '../src/index.js';

const now = '2026-09-27T12:00:00.000Z';
const nowMs = Date.parse(now);

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return ProviderSchema.parse({
    id: ProviderIdSchema.parse(id),
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
    stepsLeftToday: 50,
    ...overrides,
  });
}

function model(
  ref: string,
  overrides: Partial<ModelInfo> & { providerId?: string } = {},
): ModelInfo {
  const providerId = overrides.providerId ?? ref.slice(0, ref.indexOf('/'));
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

function firstChainEntry(): (typeof DEFAULT_AUTO_FREE_CHAIN)[number] {
  const [first] = DEFAULT_AUTO_FREE_CHAIN;
  if (!first) throw new Error('default chain is empty');
  return first;
}

function resolve(
  chain: typeof DEFAULT_AUTO_FREE_CHAIN,
  models: ModelInfo[],
  providers: Provider[],
) {
  const capacity: CapacityView = { providers, now };
  return resolveFallbackChain({
    chain,
    models,
    capacity,
    profile: autoFree,
    inputTokens: 100,
    step: 'plan',
  });
}

function reasonsFor(
  result: ReturnType<typeof resolveFallbackChain>,
  providerId: string,
  pattern: string,
): ChainSkipReason | 'hit' | undefined {
  return result.diagnostics.find((row) => row.provider === providerId && row.pattern === pattern)
    ?.status;
}

describe('QA adv: Auto-Free fallback chain', () => {
  it('resolves models in declared order and marks the first eligible as the hit', () => {
    const providers = [provider('gemini'), provider('groq'), provider('cerebras')];
    const models = [
      model('gemini/gemini-3.8-flash'),
      model('groq/qwen/qwen3.8-27b'),
      model('cerebras/gpt-oss-120b'),
    ];
    const result = resolve(DEFAULT_AUTO_FREE_CHAIN, models, providers);
    expect(result.models.map((entry) => entry.ref)).toEqual([
      'gemini/gemini-3.8-flash',
      'groq/qwen/qwen3.8-27b',
      'cerebras/gpt-oss-120b',
    ]);
    expect(result.hit).toEqual({
      provider: 'gemini',
      pattern: 'gemini-3.8-flash',
      modelRef: 'gemini/gemini-3.8-flash',
    });
    expect(reasonsFor(result, 'gemini', 'gemini-3.8-flash')).toBe('hit');
    expect(reasonsFor(result, 'groq', 'qwen/qwen3.8-27b')).toBe('available');
  });

  it('skips providers without a usable key and continues down the chain', () => {
    const providers = [
      provider('gemini', { keyStatus: 'missing' }),
      provider('groq', { keyStatus: 'invalid' }),
      provider('cerebras'),
    ];
    const models = [
      model('gemini/gemini-3.8-flash'),
      model('groq/qwen/qwen3.8-27b'),
      model('cerebras/gpt-oss-120b'),
    ];
    const result = resolve(DEFAULT_AUTO_FREE_CHAIN, models, providers);
    expect(result.models.map((entry) => entry.ref)).toEqual(['cerebras/gpt-oss-120b']);
    expect(reasonsFor(result, 'gemini', 'gemini-3.8-flash')).toBe('no_key');
    expect(reasonsFor(result, 'groq', 'qwen/qwen3.8-27b')).toBe('no_key');
    expect(result.hit?.provider).toBe('cerebras');
  });

  it('treats a keyless provider as usable and reports cooling providers', () => {
    const keyless = provider('gemini', { keyStatus: 'missing', keyRequired: false });
    const cooling = provider('groq', {
      health: 'cooldown',
      cooldownUntil: new Date(nowMs + 60_000).toISOString(),
    });
    const models = [model('gemini/gemini-3.8-flash'), model('groq/qwen/qwen3.8-27b')];
    const result = resolve(DEFAULT_AUTO_FREE_CHAIN, models, [keyless, cooling]);
    expect(result.models.map((entry) => entry.ref)).toEqual(['gemini/gemini-3.8-flash']);
    expect(reasonsFor(result, 'groq', 'qwen/qwen3.8-27b')).toBe('cooling');
  });

  it('reports tool-less and excluded-name models without adding them to the chain', () => {
    const providers = [provider('gemini'), provider('groq')];
    const models = [
      model('gemini/gemini-3.8-flash', { toolCalling: false }),
      model('groq/qwen/qwen3.8-27b', { name: 'Qwen 3.8 Live Omni' }),
    ];
    const result = resolve(DEFAULT_AUTO_FREE_CHAIN, models, providers);
    expect(result.models).toEqual([]);
    expect(reasonsFor(result, 'gemini', 'gemini-3.8-flash')).toBe('tools_unsupported');
    expect(reasonsFor(result, 'groq', 'qwen/qwen3.8-27b')).toBe('excluded_name');
  });

  it('admits an excluded-name model once it is verified for tools', () => {
    const providers = [provider('gemini')];
    const models = [model('gemini/gemini-3.8-flash', { name: 'Gemini Nano Flash' })];
    const capacity: CapacityView = { providers, now };
    const result = resolveFallbackChain({
      chain: DEFAULT_AUTO_FREE_CHAIN,
      models,
      capacity,
      profile: autoFree,
      inputTokens: 100,
      verifiedModelRefs: ['gemini/gemini-3.8-flash'],
    });
    expect(result.models.map((entry) => entry.ref)).toEqual(['gemini/gemini-3.8-flash']);
  });

  it('dedupes a model matched by more than one pattern', () => {
    const providers = [provider('gemini')];
    const models = [model('gemini/gemini-3.8-flash')];
    const result = resolve(DEFAULT_AUTO_FREE_CHAIN, models, providers);
    expect(result.models).toHaveLength(1);
    expect(
      result.diagnostics.filter((row) => row.modelRef === 'gemini/gemini-3.8-flash').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty result for an empty chain and for an unknown provider', () => {
    expect(resolve([], [model('gemini/gemini-3.8-flash')], [provider('gemini')])).toEqual({
      models: [],
      diagnostics: [],
      hit: null,
    });
    const result = resolve(DEFAULT_AUTO_FREE_CHAIN, [], [provider('gemini')]);
    expect(result.models).toEqual([]);
    expect(result.hit).toBeNull();
    expect(reasonsFor(result, 'gemini', 'gemini-3.8-flash')).toBe('not_live');
  });
});

describe('QA adv: chain profile selection', () => {
  it('uses the built-in chain only for Auto-Free and Best Available', () => {
    expect(chainForProfile(autoFree)).toEqual(DEFAULT_AUTO_FREE_CHAIN);
    const custom = { ...autoFree, name: 'Custom', fallbackChain: undefined };
    expect(chainForProfile(custom)).toEqual([]);
    const withChain = {
      ...custom,
      fallbackChain: [firstChainEntry()],
    };
    expect(chainForProfile(withChain)).toEqual([firstChainEntry()]);
  });
});

describe('QA adv: strict fallback name eligibility', () => {
  it('requires tool verification for preview/omni/nano-style names', () => {
    expect(isStrictFallbackNameEligible(model('gemini/gemini-3.8-flash'), [])).toBe(true);
    const omni = model('gemini/gemini-3.8-flash', { name: 'Gemini Omni' });
    expect(isStrictFallbackNameEligible(omni, [])).toBe(false);
    expect(isStrictFallbackNameEligible(omni, ['gemini/gemini-3.8-flash'])).toBe(true);
    const nano = model('groq/qwen/qwen3.8-27b', { name: 'Qwen Nano' });
    expect(isStrictFallbackNameEligible(nano, [])).toBe(false);
    const toolLessOmni = model('gemini/gemini-3.8-flash', {
      name: 'Gemini Omni',
      toolCalling: false,
    });
    expect(isStrictFallbackNameEligible(toolLessOmni, ['gemini/gemini-3.8-flash'])).toBe(false);
  });
});
