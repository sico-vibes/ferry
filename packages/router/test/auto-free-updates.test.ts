import { describe, expect, it } from 'vitest';
import type { ModelInfo, Provider } from '@ferry/shared';
import { BUILTIN_PROFILES, DEFAULT_AUTO_FREE_CHAIN, resolveFallbackChain } from '../src/index.js';

describe('community-informed Auto-Free chain', () => {
  it('prefers Gemini Flash-Lite, elevates tool-reliable gpt-oss, and omits Cerebras', () => {
    const ids = DEFAULT_AUTO_FREE_CHAIN.map((entry) => String(entry.provider));
    expect(ids).not.toContain('cerebras');
    expect(ids.indexOf('gemini')).toBeLessThan(ids.indexOf('groq'));
    expect(ids.indexOf('groq')).toBeLessThan(ids.indexOf('nvidia'));
    expect(DEFAULT_AUTO_FREE_CHAIN[0]?.patterns[0]).toContain('flash-lite');
    expect(
      DEFAULT_AUTO_FREE_CHAIN.find((entry) => String(entry.provider) === 'groq')?.patterns[0],
    ).toBe('openai/gpt-oss-120b');
  });

  it('includes current free community favourites and marks Kilo promotions by provider policy', () => {
    const allPatterns = DEFAULT_AUTO_FREE_CHAIN.flatMap((entry) => entry.patterns);
    expect(allPatterns).toEqual(
      expect.arrayContaining([
        'deepseek/deepseek-v4-flash:free',
        'z-ai/glm-5*:free',
        'nvidia/nemotron-3-ultra*:free',
        'minimax/minimax-m3:free',
        'minimax/minimax-m2.5:free',
        'qwen/qwen3-coder:free',
        'stepfun/step-*-flash:free',
        'moonshotai/kimi-*:free',
        'longcat/longcat-*:free',
      ]),
    );
  });

  it('honors the avoid-training setting while resolving a live chain', () => {
    const autoFree = BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    const provider: Provider = {
      id: 'groq' as Provider['id'],
      name: 'Groq',
      tag: 'legit',
      kind: 'api',
      brand: 'groq',
      keyStatus: 'valid',
      enabled: true,
      health: 'ok',
      cooldownUntil: null,
      dataUse: 'Requests may be used to improve products.',
      termsNote: null,
      signupUrl: null,
      docsUrl: null,
      verifiedAt: null,
      modelCount: 1,
      windows: [],
      stepsLeftToday: 20,
    };
    const model: ModelInfo = {
      ref: 'groq/openai/gpt-oss-120b' as ModelInfo['ref'],
      providerId: provider.id,
      name: 'GPT OSS 120B',
      tier: 'T2',
      contextWindow: 128_000,
      maxOutput: 8_192,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    };
    const input = {
      chain: [{ provider: provider.id, patterns: ['openai/gpt-oss-120b'] }],
      models: [model],
      capacity: { providers: [provider], now: '2026-09-27T12:00:00.000Z' },
      profile: autoFree,
      inputTokens: 100,
    };
    const defaultResult = resolveFallbackChain(input);
    expect(defaultResult.models, JSON.stringify(defaultResult.diagnostics)).toHaveLength(1);
    expect(resolveFallbackChain({ ...input, avoidTrainingProviders: true }).models).toHaveLength(0);
  });
});
