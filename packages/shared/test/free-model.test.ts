import { describe, expect, it } from 'vitest';
import { isModelFreeForPlan, ProviderIdSchema } from '../src/index.js';
import type { ModelInfo } from '../src/index.js';

const model = (
  providerId: string,
  overrides: Partial<Pick<ModelInfo, 'ref' | 'free' | 'priceInPerM' | 'priceOutPerM'>> = {},
) => ({
  ref: `${providerId}/model` as ModelInfo['ref'],
  providerId: ProviderIdSchema.parse(providerId),
  free: true,
  priceInPerM: 0,
  priceOutPerM: 0,
  ...overrides,
});

describe('isModelFreeForPlan', () => {
  it.each([
    ['anthropic', 'paid', false],
    ['anyapi', 'caution', true],
    ['cerebras', 'trial', false],
    ['cloudflare-workers-ai', 'legit', true],
    ['chutes', 'caution', true],
    ['gemini-cli', 'caution', true],
    ['github-models', 'caution', true],
    ['kiro', 'caution', true],
    ['qwen-code-oauth', 'caution', true],
    ['zenmux', 'caution', true],
    ['deepinfra', 'credits', false],
    ['deepseek', 'paid', false],
    ['fireworks', 'credits', false],
    ['gemini', 'legit', true],
    ['groq', 'legit', true],
    ['huggingface', 'credits', false],
    ['hyperbolic', 'credits', false],
    ['kilo', 'promo', true],
    ['llm7', 'caution', true],
    ['mistral', 'caution', true],
    ['nebius', 'credits', false],
    ['novita', 'credits', false],
    ['nvidia', 'legit', true],
    ['openai', 'paid', false],
    ['opencode-go', 'subscription_cli', true],
    ['opencode', 'promo', false],
    ['openrouter', 'legit', true],
    ['ovhcloud', 'legit', true],
    ['sambanova', 'legit', true],
    ['scaleway', 'credits', false],
    ['stepfun', 'credits', false],
    ['together', 'credits', false],
    ['tokenrouter', 'caution', true],
    ['vercel-ai-gateway', 'credits', false],
    ['zai-glm', 'legit', true],
  ] as const)('classifies %s', (id, tag, expected) => {
    const entry = model(id, { free: true });
    expect(isModelFreeForPlan({ id: ProviderIdSchema.parse(id), tag }, entry)).toBe(expected);
  });

  it('keeps priced models billable even on free or promotional plans', () => {
    for (const [id, tag] of [
      ['groq', 'legit'],
      ['kilo', 'promo'],
      ['fireworks', 'credits'],
      ['openai', 'paid'],
    ] as const) {
      expect(
        isModelFreeForPlan(
          { id: ProviderIdSchema.parse(id), tag },
          model(id, { priceOutPerM: 0.01 }),
        ),
      ).toBe(false);
    }
  });

  it.each([
    ['llm7', 'caution'],
    ['ovhcloud', 'legit'],
    ['anyapi', 'caution'],
    ['sambanova', 'legit'],
  ] as const)('allows unpriced models on sourced free plan %s', (id, tag) => {
    const freePlan = { sourceUrl: 'https://provider.example/pricing', models: ['*'] };
    expect(
      isModelFreeForPlan(
        { id: ProviderIdSchema.parse(id), tag, freePlan },
        model(id, { free: false, priceInPerM: null, priceOutPerM: null }),
      ),
    ).toBe(true);
    expect(
      isModelFreeForPlan(
        { id: ProviderIdSchema.parse(id), tag, freePlan },
        model(id, { free: false, priceInPerM: null, priceOutPerM: 0.01 }),
      ),
    ).toBe(true);
  });

  it('uses explicit free-plan model patterns and exclusions', () => {
    const provider = {
      id: ProviderIdSchema.parse('gemini'),
      tag: 'legit' as const,
      freePlan: {
        sourceUrl: 'https://provider.example/pricing',
        models: ['gemini-*-flash*'],
        excludedModels: ['gemini-*-flash-image*'],
      },
    };
    expect(
      isModelFreeForPlan(provider, {
        ...model('gemini', { ref: 'gemini/gemini-3.8-flash' as ModelInfo['ref'] }),
        priceInPerM: 1,
        priceOutPerM: 4,
      }),
    ).toBe(true);
    expect(
      isModelFreeForPlan(provider, {
        ...model('gemini', { ref: 'gemini/gemini-3.1-flash-image' as ModelInfo['ref'] }),
        priceInPerM: 1,
        priceOutPerM: 4,
      }),
    ).toBe(false);
    expect(
      isModelFreeForPlan(provider, {
        ...model('gemini', { ref: 'gemini/gemini-3.1-pro-preview' as ModelInfo['ref'] }),
        priceInPerM: 1,
        priceOutPerM: 4,
      }),
    ).toBe(false);
  });

  it('keeps list-priced models free on the sourced free-tier billing setting only', () => {
    const id = ProviderIdSchema.parse('groq');
    const entry = model('groq', { priceInPerM: 0.5, priceOutPerM: 2 });
    const freeProvider = {
      id,
      tag: 'legit' as const,
      freePlan: { sourceUrl: 'https://provider.example/pricing', models: ['openai/gpt-oss-*'] },
    };
    const modelRef = { ...entry, ref: 'groq/openai/gpt-oss-120b' as ModelInfo['ref'] };
    expect(isModelFreeForPlan(freeProvider, modelRef)).toBe(true);
    expect(isModelFreeForPlan({ ...freeProvider, billingEnabled: true }, modelRef)).toBe(false);
  });

  it('keeps unpriced models billable when no sourced free plan is declared', () => {
    expect(
      isModelFreeForPlan(
        { id: ProviderIdSchema.parse('groq'), tag: 'legit' },
        model('groq', { free: false, priceInPerM: null, priceOutPerM: null }),
      ),
    ).toBe(false);
  });

  it('allows a non-suffixed OpenRouter promotion only with two known zero prices', () => {
    const bunny = model('openrouter', {
      ref: 'openrouter/stealth/space-bunny-alpha' as ModelInfo['ref'],
      free: true,
    });
    const provider = { id: ProviderIdSchema.parse('openrouter'), tag: 'legit' as const };
    expect(isModelFreeForPlan(provider, bunny)).toBe(true);
    expect(isModelFreeForPlan(provider, { ...bunny, priceOutPerM: null })).toBe(false);
    expect(isModelFreeForPlan(provider, { ...bunny, priceOutPerM: 0.01 })).toBe(false);
  });

  it('allows explicit free OpenRouter models on a credit-backed account', () => {
    expect(
      isModelFreeForPlan(
        { id: ProviderIdSchema.parse('openrouter'), tag: 'legit', billingEnabled: true },
        model('openrouter', { ref: 'openrouter/qwen/model:free' as ModelInfo['ref'] }),
      ),
    ).toBe(true);
    expect(
      isModelFreeForPlan(
        { id: ProviderIdSchema.parse('openrouter'), tag: 'legit', billingEnabled: true },
        model('openrouter', {
          ref: 'openrouter/qwen/model:free' as ModelInfo['ref'],
          priceInPerM: null,
          priceOutPerM: null,
        }),
      ),
    ).toBe(true);
  });

  it('never lets a stale zero price bypass a paid account outside OpenRouter', () => {
    expect(
      isModelFreeForPlan(
        { id: ProviderIdSchema.parse('groq'), tag: 'legit', billingEnabled: true },
        model('groq'),
      ),
    ).toBe(false);
  });

  it.each([
    ['deepinfra', 'credits'],
    ['fireworks', 'credits'],
    ['openai', 'paid'],
  ] as const)('rejects catalog zero prices from Auto-Free on %s', (id, tag) => {
    expect(isModelFreeForPlan({ id: ProviderIdSchema.parse(id), tag }, model(id))).toBe(false);
  });

  it('requires explicit trial opt-in', () => {
    const provider = { id: ProviderIdSchema.parse('cerebras'), tag: 'trial' } as const;
    const entry = model('cerebras');
    expect(isModelFreeForPlan(provider, entry)).toBe(false);
    expect(isModelFreeForPlan(provider, entry, ['cerebras'])).toBe(true);
  });
});
