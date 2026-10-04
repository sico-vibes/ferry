import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ModelInfo, Profile, Provider, TaskRecord } from '@ferry/shared';
import { DEFAULT_ROUTING_SETTINGS } from '@ferry/shared';
import {
  BUILTIN_PROFILES,
  buildBriefing,
  calculateSpend,
  canSpend,
  requiresConfirmation,
  classifyStep,
  runSimulationScenarios,
  scoreModels,
  explainModelRouting,
  shouldSwitchBeforeStep,
  resolveFallbackChain,
  isStrictFallbackNameEligible,
  resolveLogicalModelCandidates,
  classifyProviderError,
  type CapacityView,
} from '../src/index.js';

const profileResult = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
if (!profileResult) throw new Error('Best Available profile fixture is missing');
const profile: Profile = profileResult;
describe('logical model mapping', () => {
  it('resolves configured upstream models and lets a user replace one provider mapping', () => {
    const template: ModelInfo = {
      ref: 'groq/base' as ModelInfo['ref'],
      providerId: 'groq' as ModelInfo['providerId'],
      name: 'test model',
      tier: 'T2',
      contextWindow: 32_000,
      maxOutput: 4_000,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    };
    const models: ModelInfo[] = [
      {
        ...template,
        ref: 'groq/openai/gpt-oss-120b' as ModelInfo['ref'],
        providerId: 'groq' as ModelInfo['providerId'],
      },
      {
        ...template,
        ref: 'cerebras/gpt-oss-120b' as ModelInfo['ref'],
        providerId: 'cerebras' as ModelInfo['providerId'],
      },
      {
        ...template,
        ref: 'openrouter/openai/gpt-oss-120b:free' as ModelInfo['ref'],
        providerId: 'openrouter' as ModelInfo['providerId'],
      },
    ];
    const defaults = [
      {
        logicalName: 'gpt-oss-120b',
        providerId: 'groq' as ModelInfo['providerId'],
        upstreamId: 'openai/gpt-oss-120b',
      },
      {
        logicalName: 'gpt-oss-120b',
        providerId: 'cerebras' as ModelInfo['providerId'],
        upstreamId: 'gpt-oss-120b',
      },
    ];
    const user = [
      {
        logicalName: 'gpt-oss-120b',
        providerId: 'groq' as ModelInfo['providerId'],
        upstreamId: 'openai/gpt-oss-120b-preview',
      },
      {
        logicalName: 'gpt-oss-120b',
        providerId: 'openrouter' as ModelInfo['providerId'],
        upstreamId: 'openai/gpt-oss-120b:free',
      },
    ];
    expect(
      resolveLogicalModelCandidates('gpt-oss-120b', models, defaults, user).map(
        (model) => model.ref,
      ),
    ).toEqual(['cerebras/gpt-oss-120b', 'openrouter/openai/gpt-oss-120b:free']);
  });
  it('classifies a remapped quota response as a retryable key handoff', () => {
    expect(classifyProviderError({ statusCode: 429, message: 'quota exceeded' })).toMatchObject({
      family: 'quota_exhausted',
      scope: 'key',
      retryable: true,
    });
  });
});
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
  dataUse: null,
  termsNote: null,
  signupUrl: null,
  docsUrl: null,
  verifiedAt: null,
  modelCount: 1,
  windows: [],
  stepsLeftToday: 20,
};
const model: ModelInfo = {
  ref: 'groq/llama' as ModelInfo['ref'],
  providerId: provider.id,
  name: 'Llama',
  tier: 'T2',
  contextWindow: 128_000,
  maxOutput: 8_192,
  toolCalling: true,
  reasoning: false,
  free: true,
  priceInPerM: 0,
  priceOutPerM: 0,
};
const capacity: CapacityView = { providers: [provider], now: '2026-09-24T12:00:00.000Z' };
const task: TaskRecord = {
  sessionId: 'session_00000000000000000000' as TaskRecord['sessionId'],
  goal: 'Finish routing',
  plan: [{ id: '1', text: 'Implement and verify', status: 'doing' }],
  decisions: [],
  touchedFiles: [],
  nextStep: 'Run gates',
};

describe('step classification and routing', () => {
  it('only routes Kilo models covered by its sourced plan or priced at zero through Auto-Free', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    // Kilo coverage is the exact sourced variant list; a different :free model is not implied.
    const kilo: Provider = {
      ...provider,
      id: 'kilo' as Provider['id'],
      freePlan: {
        sourceUrl: 'https://kilo.ai/docs/gateway/usage-and-billing',
        models: [
          'stepfun/step-3.7-flash:free',
          'poolside/laguna-s-2.1:free',
          'nvidia/nemotron-3-ultra-550b-a55b:free',
          'tencent/hy3:free',
          'openrouter/free',
        ],
      },
    };
    const models: ModelInfo[] = [
      {
        ...model,
        ref: 'kilo/deepseek/deepseek-v4-pro' as ModelInfo['ref'],
        providerId: kilo.id,
        free: true,
        priceInPerM: null,
        priceOutPerM: null,
      },
      {
        ...model,
        ref: 'kilo/qwen/qwen3.6-27b' as ModelInfo['ref'],
        providerId: kilo.id,
        free: false,
        priceInPerM: 0.2,
        priceOutPerM: 0.4,
      },
      {
        ...model,
        ref: 'kilo/nvidia/nemotron-3-ultra-550b-a55b:free' as ModelInfo['ref'],
        providerId: kilo.id,
        free: false,
        priceInPerM: null,
        priceOutPerM: null,
      },
      {
        ...model,
        ref: 'kilo/local-zero' as ModelInfo['ref'],
        providerId: kilo.id,
        free: false,
        priceInPerM: 0,
        priceOutPerM: 0,
      },
    ];
    const candidates = scoreModels({
      models,
      providers: [kilo],
      capacity: { providers: [kilo], now: '2026-09-29T12:00:00.000Z' },
      profile: autoFree,
      step: 'edit',
      estimate: { inputTokens: 100, requiresTools: true },
    });
    expect(candidates.map(({ ref }) => ref)).toEqual(
      expect.arrayContaining(['kilo/nvidia/nemotron-3-ultra-550b-a55b:free', 'kilo/local-zero']),
    );
    expect(candidates).toHaveLength(2);
  });

  it('keeps missing quality neutral and keeps quality weight independent of reliability', () => {
    const input = {
      models: [model],
      providers: [provider],
      capacity,
      profile,
      step: 'plan' as const,
      estimate: { inputTokens: 1, requiresTools: true },
    };
    const unknown = scoreModels({ ...input, models: [{ ...model, quality: null }] })[0];
    const baseline = scoreModels(input)[0];
    const stats = [
      {
        modelRef: model.ref,
        toolCalls: 4,
        toolCallValidationFailures: 1,
        averageLatencyMs: 2_000,
        cacheAffinity: 0,
      },
    ];
    const unknownWithStats = scoreModels({
      ...input,
      models: [{ ...model, quality: null }],
      routing: { ...DEFAULT_ROUTING_SETTINGS, smartReliability: false, qualityWeight: 10 },
      stats,
    })[0];
    const known = scoreModels({
      ...input,
      models: [{ ...model, quality: 1 }],
      routing: { ...DEFAULT_ROUTING_SETTINGS, smartReliability: false, qualityWeight: 10 },
      stats,
    })[0];
    expect(unknown?.scoreBreakdown?.quality).toBe(0);
    expect(unknown?.score).toBe(baseline?.score);
    expect(known?.scoreBreakdown?.quality).toBe(6.5);
    expect(known?.scoreBreakdown?.success).toBe(unknownWithStats?.scoreBreakdown?.success);
  });

  it('allows XML tool fallback only when the routing flag is enabled', () => {
    const xmlModel: ModelInfo = {
      ...model,
      toolCalling: false,
      capability: {
        toolCall: false,
        parallelToolCalls: null,
        vision: false,
        reasoning: false,
        context: model.contextWindow,
        maxOutput: model.maxOutput,
        editFormat: 'whole',
        toolProtocol: 'xml',
        cachePrompt: null,
        temperature: null,
      },
    };
    const input = {
      models: [xmlModel],
      providers: [provider],
      capacity,
      profile,
      step: 'plan' as const,
      estimate: { inputTokens: 1, requiresTools: true },
    };
    expect(scoreModels(input)).toHaveLength(0);
    expect(scoreModels({ ...input, textToolFallbackEnabled: true })).toHaveLength(1);
  });

  it('allows a discovered model with unknown tool capability on tool steps', () => {
    const unknownModel: ModelInfo = {
      ...model,
      toolCalling: true,
      capability: {
        toolCall: null,
        parallelToolCalls: null,
        vision: false,
        reasoning: false,
        context: model.contextWindow,
        maxOutput: model.maxOutput,
        editFormat: 'whole',
        toolProtocol: 'none',
        cachePrompt: null,
        temperature: null,
      },
    };
    const candidates = scoreModels({
      models: [unknownModel],
      providers: [provider],
      capacity,
      profile,
      step: 'plan',
      estimate: { inputTokens: 1, requiresTools: true },
    });
    expect(candidates.map((candidate) => candidate.ref)).toEqual([unknownModel.ref]);
  });

  it('excludes unpriced models outside a sourced free plan and explains the exclusion', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    // Round 3 policy: unknown prices require model coverage from a sourced provider plan.
    const discovered = { ...model, free: false, priceInPerM: null, priceOutPerM: null };
    const input = {
      models: [discovered],
      providers: [provider],
      capacity,
      profile: autoFree,
      step: 'plan' as const,
      estimate: { inputTokens: 1, requiresTools: true },
    };
    expect(scoreModels(input)).toHaveLength(0);
    expect(explainModelRouting(input)[0]?.reasons).toContain(
      'unknown pricing is not allowed for this provider plan',
    );

    const paidProvider = { ...provider, tag: 'paid' as const };
    expect(
      scoreModels({
        ...input,
        providers: [paidProvider],
        capacity: { providers: [paidProvider], now: '2026-09-24T12:00:00.000Z' },
      }),
    ).toHaveLength(0);
    const creditsProvider = { ...provider, tag: 'credits' as const };
    expect(
      scoreModels({
        ...input,
        models: [{ ...model, free: true, priceInPerM: 0, priceOutPerM: 0 }],
        providers: [creditsProvider],
        capacity: { providers: [creditsProvider], now: '2026-09-24T12:00:00.000Z' },
      }),
    ).toHaveLength(0);
    const zenProvider = { ...provider, id: 'opencode' as Provider['id'] };
    expect(
      scoreModels({
        ...input,
        models: [
          {
            ...model,
            ref: 'opencode/deepseek-v4-flash' as ModelInfo['ref'],
            providerId: zenProvider.id,
          },
        ],
        providers: [zenProvider],
        capacity: { providers: [zenProvider], now: '2026-09-24T12:00:00.000Z' },
      }),
    ).toHaveLength(0);
    const cautionProvider = { ...provider, tag: 'caution' as const };
    expect(
      scoreModels({
        ...input,
        providers: [cautionProvider],
        capacity: { providers: [cautionProvider], now: '2026-09-24T12:00:00.000Z' },
      }),
    ).toHaveLength(0);
    const openRouterModel = {
      ...discovered,
      ref: 'openrouter/meta/paid-model' as ModelInfo['ref'],
      providerId: 'openrouter' as Provider['id'],
    };
    const openRouterProvider = { ...provider, id: 'openrouter' as Provider['id'] };
    expect(
      scoreModels({
        ...input,
        models: [openRouterModel],
        providers: [openRouterProvider],
        capacity: { providers: [openRouterProvider], now: '2026-09-24T12:00:00.000Z' },
      }),
    ).toHaveLength(0);

    const excluded = { ...provider, health: 'down' as const, keyStatus: 'invalid' as const };
    expect(
      explainModelRouting({
        ...input,
        providers: [excluded],
        capacity: { providers: [excluded], now: '2026-09-24T12:00:00.000Z' },
      })[0]?.reasons,
    ).toEqual(expect.arrayContaining(['provider health is down', 'provider key marked invalid']));
  });

  it('ranks verified coding and tool models ahead of small omni or nano variants', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    const preferred = {
      ...model,
      ref: 'gemini/gemini-3.8-flash' as ModelInfo['ref'],
      providerId: 'gemini' as Provider['id'],
      name: 'Gemini Flash',
    };
    const nano = {
      ...model,
      ref: 'nvidia/nemotron-3-nano-30b' as ModelInfo['ref'],
      providerId: 'nvidia' as Provider['id'],
      name: 'Nemotron Nano',
    };
    const omni = {
      ...model,
      ref: 'nvidia/nemotron-3-nano-omni-reasoning' as ModelInfo['ref'],
      providerId: 'nvidia' as Provider['id'],
      name: 'Nemotron Nano Omni Reasoning',
    };
    const gemini = { ...provider, id: 'gemini' as Provider['id'] };
    const nvidia = { ...provider, id: 'nvidia' as Provider['id'] };
    const ranked = scoreModels({
      models: [nano, omni, preferred],
      providers: [gemini, nvidia],
      capacity: { providers: [gemini, nvidia], now: '2026-09-24T12:00:00.000Z' },
      profile: autoFree,
      step: 'plan',
      estimate: { inputTokens: 1, requiresTools: true },
      preferredModelRefs: [preferred.ref],
    });
    expect(ranked.map(({ ref }) => ref)).toEqual([preferred.ref]);
  });

  it('routes the reported mixed-provider candidate set by score and filters account exclusions', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    const refs = [
      'nvidia/deepseek-ai/deepseek-coder-6.7b-instruct',
      'nvidia/deepseek-ai/deepseek-v4.1-flash',
      'opencode/ling-3.0-flash-fin-free',
      'opencode/deepseek-v4-flash',
      'opencode/deepseek-v4-pro',
      'opencode/deepseek-v4.1-flash',
      'kilo/qwen/qwen3.8-27b:free',
      'openrouter/inclusionai/ling-3.0-flash-fin:free',
      'openrouter/qwen/qwen3.8-27b:free',
      'gemini/antigravity-preview-05-2026',
      'gemini/gemini-3.8-flash',
      'groq/qwen/qwen3.8-27b',
      'mistral/codestral-2508',
      'cerebras/gpt-oss-120b',
    ];
    const providerIds = [...new Set(refs.map((ref) => ref.slice(0, ref.indexOf('/'))))];
    const providers = providerIds.map((id) => ({
      ...provider,
      id: id as Provider['id'],
      stepsLeftToday: id === 'nvidia' ? null : 20,
      ...(id === 'opencode' ? { freeTierUnsupported: true } : {}),
      ...(id === 'kilo' ? { tag: 'credits' as const } : {}),
      ...(id === 'gemini'
        ? {
            excludedModelRefs: ['gemini/antigravity-preview-05-2026' as ModelInfo['ref']],
          }
        : {}),
    }));
    const models = refs.map((ref) => ({
      ...model,
      ref: ref as ModelInfo['ref'],
      providerId: ref.slice(0, ref.indexOf('/')) as Provider['id'],
      name: ref,
      contextWindow: 262_144,
    }));
    const verifiedModelRefs = [
      'gemini/gemini-3.8-flash',
      'groq/qwen/qwen3.8-27b',
      'mistral/codestral-2508',
      'cerebras/gpt-oss-120b',
    ];
    const candidates = scoreModels({
      models,
      providers,
      capacity: { providers, now: '2026-09-24T12:00:00.000Z' },
      profile: autoFree,
      step: 'plan',
      estimate: { inputTokens: 1_000, requiresTools: true },
      verifiedModelRefs,
    });
    expect(candidates.map(({ ref }) => ref)).not.toContain('opencode/ling-3.0-flash-fin-free');
    expect(candidates.map(({ ref }) => ref)).not.toContain('opencode/deepseek-v4-flash');
    expect(candidates.map(({ ref }) => ref)).not.toContain('opencode/deepseek-v4-pro');
    expect(candidates.map(({ ref }) => ref)).not.toContain('opencode/deepseek-v4.1-flash');
    expect(candidates.map(({ ref }) => ref)).not.toContain('kilo/qwen/qwen3.8-27b:free');
    expect(candidates.map(({ ref }) => ref)).not.toContain('gemini/antigravity-preview-05-2026');
    expect(candidates[0]?.ref).toBe('cerebras/gpt-oss-120b');
    expect(candidates.map(({ score }) => score)).toEqual(
      [...candidates.map(({ score }) => score)].sort((a, b) => b - a),
    );
    for (const candidate of candidates) {
      const breakdown = candidate.scoreBreakdown;
      expect(breakdown).toBeDefined();
      if (breakdown)
        expect(
          breakdown.tierFit +
            breakdown.headroom +
            breakdown.success +
            breakdown.latency +
            breakdown.cost +
            breakdown.affinity +
            breakdown.coding +
            breakdown.preference +
            breakdown.reasoning +
            breakdown.verification,
        ).toBeCloseTo(candidate.score);
    }
  });

  it('selects the first live model from the default chain and excludes the repro domain models', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    const refs = [
      'gemini/antigravity-preview-05-2026',
      'gemini/antigravity-preview-09-2026',
      'gemini/antigravity-preview-latest',
      'gemini/aqa',
      'gemini/deep-research-pro-preview-12-2025',
      'gemini/gemini-3.8-live',
      'gemini/gemini-3.8-live-extended-thinking',
      'gemini/gemini-pro-latest',
      'gemini/gemini-robotics-er-2-preview',
      'gemini/gemini-robotics-er-2-streaming-preview',
      'gemini/gemma-4-26b-a4b-it',
      'gemini/gemma-4-31b-it',
      'gemini/gemini-omni-1.1-flash',
      'gemini/lyria-3.5',
      'gemini/lyria-realtime-exp',
      'gemini/nano-banana-pro-preview',
      'gemini/gemini-3.8-flash',
      'openrouter/inclusionai/ling-3.0-flash-fin:free',
      'openrouter/inclusionai/ling-3.0-flash-sante:free',
      'openrouter/qwen/qwen3.8-27b:free',
      'openrouter/dots-studio/dots-3-note-preview:free',
      'openrouter/google/gemma-4-26b-a4b-it:free',
      'openrouter/google/gemma-4-31b-it:free',
      'openrouter/liquid/lfm-2.5-2.6b:free',
      'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
      'openrouter/nvidia/nemotron-3.5-lightning:free',
      'openrouter/poolside/laguna-s-2.1:free',
      'openrouter/poolside/laguna-xs-2.1:free',
      'openrouter/thinkingmachines/inkling-small:free',
      'openrouter/thinkingmachines/inkling:free',
      'openrouter/cohere/north-mini-code:free',
      'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    ];
    const providers = ['gemini', 'openrouter'].map((id) => ({
      ...provider,
      id: id as Provider['id'],
      stepsLeftToday: 20,
    }));
    const liveModels = refs.map((ref) => ({
      ...model,
      ref: ref as ModelInfo['ref'],
      providerId: ref.slice(0, ref.indexOf('/')) as Provider['id'],
      name: ref,
    }));
    const result = resolveFallbackChain({
      chain: autoFree.fallbackChain ?? [],
      models: liveModels,
      capacity: { providers, now: '2026-09-26T12:00:00.000Z' },
      profile: autoFree,
      inputTokens: 1_000,
      verifiedModelRefs: [],
    });
    expect(result.hit?.modelRef).toBe('gemini/gemini-3.8-flash');
    expect(result.models[0]?.ref).toBe('gemini/gemini-3.8-flash');
    const candidates = scoreModels({
      models: liveModels,
      providers,
      capacity: { providers, now: '2026-09-26T12:00:00.000Z' },
      profile: autoFree,
      step: 'plan',
      estimate: { inputTokens: 1_000, requiresTools: true },
    });
    expect(candidates.map(({ ref }) => ref)).not.toContain(
      'openrouter/inclusionai/ling-3.0-flash-fin:free',
    );
    expect(candidates.map(({ ref }) => ref)).not.toContain(
      'openrouter/inclusionai/ling-3.0-flash-sante:free',
    );
    expect(candidates.map(({ ref }) => ref)).not.toContain('gemini/aqa');
    expect(candidates.map(({ ref }) => ref)).not.toContain('gemini/gemini-3.8-live');
  });

  it('treats paid API list prices as zero cost on free provider plans and honors paid overrides', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    const pricedGemini = {
      ...model,
      ref: 'gemini/gemini-3.8-flash' as ModelInfo['ref'],
      providerId: 'gemini' as Provider['id'],
      name: 'Gemini 3.8 Flash',
      free: false,
      priceInPerM: 0.1,
      priceOutPerM: 0.4,
    };
    // The fixture mirrors the catalog's per-model free-plan coverage, not a provider-wide tag.
    const freeGemini = {
      ...provider,
      id: 'gemini' as Provider['id'],
      tag: 'legit' as const,
      freePlan: {
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        models: ['gemini-3.8-flash'],
      },
    };
    const chain = autoFree.fallbackChain ?? [];
    const result = resolveFallbackChain({
      chain,
      models: [pricedGemini],
      capacity: { providers: [freeGemini], now: '2026-09-26T12:00:00.000Z' },
      profile: autoFree,
      inputTokens: 1_000,
    });
    expect(result.hit?.modelRef).toBe(pricedGemini.ref);
    expect(
      scoreModels({
        models: [pricedGemini],
        providers: [freeGemini],
        capacity: { providers: [freeGemini], now: '2026-09-26T12:00:00.000Z' },
        profile: autoFree,
        step: 'plan',
        estimate: { inputTokens: 1_000, requiresTools: true },
      })[0]?.explanation,
    ).toContain('free');

    const paidGemini = { ...freeGemini, tag: 'paid' as const };
    const paidResult = resolveFallbackChain({
      chain,
      models: [pricedGemini],
      capacity: { providers: [paidGemini], now: '2026-09-26T12:00:00.000Z' },
      profile: autoFree,
      inputTokens: 1_000,
    });
    expect(paidResult.hit).toBeNull();
    expect(
      paidResult.diagnostics.find((entry) => entry.modelRef === pricedGemini.ref)?.detail,
    ).toContain('model not marked free for this provider plan');

    const billedGemini = { ...freeGemini, billingEnabled: true };
    expect(
      scoreModels({
        models: [pricedGemini],
        providers: [billedGemini],
        capacity: { providers: [billedGemini], now: '2026-09-26T12:00:00.000Z' },
        profile: autoFree,
        step: 'plan',
        estimate: { inputTokens: 1_000, requiresTools: true },
      }),
    ).toHaveLength(0);
  });

  it('uses sourced free-plan coverage for keyless providers and explains strict-name exclusions', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    // Keyless access is not a free-tier rule; Gemini still needs sourced model coverage.
    const keyless = {
      ...provider,
      id: 'gemini' as Provider['id'],
      keyStatus: 'missing' as const,
      keyRequired: false,
      freePlan: {
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        models: ['gemini-3.8-flash'],
      },
    };
    const eligible = {
      ...model,
      ref: 'gemini/gemini-3.8-flash' as ModelInfo['ref'],
      providerId: keyless.id,
      free: false,
      priceInPerM: 0.1,
      priceOutPerM: 0.4,
    };
    const preview = {
      ...eligible,
      ref: 'gemini/antigravity-preview-05-2026' as ModelInfo['ref'],
      name: 'Antigravity Preview',
    };
    const input = {
      models: [eligible, preview],
      providers: [keyless],
      capacity: { providers: [keyless], now: '2026-09-26T12:00:00.000Z' },
      profile: autoFree,
      step: 'plan' as const,
      estimate: { inputTokens: 100, requiresTools: true },
    };
    expect(scoreModels(input).map(({ ref }) => ref)).toEqual([eligible.ref]);
    expect(
      resolveFallbackChain({
        chain: autoFree.fallbackChain ?? [],
        models: [eligible],
        capacity: input.capacity,
        profile: autoFree,
        inputTokens: 100,
      }).hit?.modelRef,
    ).toBe(eligible.ref);
    expect(explainModelRouting({ ...input, models: [preview] })[0]?.reasons).toContain(
      'model name excluded from automatic coding routes',
    );
  });

  it('skips a cooling Gemini chain hit and deterministically falls through to Groq', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    const providers = [
      {
        ...provider,
        id: 'gemini' as Provider['id'],
        health: 'cooldown' as const,
        cooldownUntil: '2026-09-26T12:01:00.000Z',
      },
      { ...provider, id: 'groq' as Provider['id'] },
    ];
    const models = [
      {
        ...model,
        ref: 'gemini/gemini-3.8-flash' as ModelInfo['ref'],
        providerId: 'gemini' as Provider['id'],
      },
      {
        ...model,
        ref: 'groq/qwen/qwen3.8-27b' as ModelInfo['ref'],
        providerId: 'groq' as Provider['id'],
      },
    ];
    const result = resolveFallbackChain({
      chain: autoFree.fallbackChain ?? [],
      models,
      capacity: { providers, now: '2026-09-26T12:00:00.000Z' },
      profile: autoFree,
      inputTokens: 1_000,
      verifiedModelRefs: [],
    });
    expect(result.hit?.modelRef).toBe('groq/qwen/qwen3.8-27b');
    expect(result.diagnostics.some((entry) => entry.status === 'cooling')).toBe(true);
  });

  it('only permits excluded names into a coding chain after tool verification', () => {
    const preview = {
      ...model,
      ref: 'gemini/gemini-3.8-live' as ModelInfo['ref'],
      providerId: 'gemini' as Provider['id'],
      name: 'Gemini 3.8 Live',
    };
    expect(isStrictFallbackNameEligible(preview, [])).toBe(false);
    expect(isStrictFallbackNameEligible(preview, [preview.ref])).toBe(true);
  });

  it('applies classification precedence', () => {
    expect(classifyStep({ firstStep: true, afterDelegationResult: true })).toBe('plan');
    expect(classifyStep({ afterDelegationResult: true, compaction: true })).toBe('review');
    expect(classifyStep({ compaction: true, pendingEdits: true })).toBe('summarize');
    expect(classifyStep({ estimatedInputTokens: 100_001 })).toBe('long_context');
    expect(classifyStep({ readCount: 2 })).toBe('search');
  });

  it('excludes models that exceed available TPM or profile spend caps', () => {
    const candidates = scoreModels({
      models: [model],
      capacity: { ...capacity, tokensPerMinuteRemaining: { groq: 99 } },
      profile,
      step: 'edit',
      estimate: { inputTokens: 100, outputTokens: 1 },
    });
    expect(candidates).toHaveLength(0);
  });

  it('hard-filters a request larger than model TPM and explains the token estimate', () => {
    const autoFree = BUILTIN_PROFILES.find((item) => item.id === 'profile_builtin_auto_free');
    if (!autoFree) throw new Error('Auto-Free profile fixture is missing');
    const qwen: ModelInfo = {
      ...model,
      ref: 'groq/qwen/qwen3.8-27b' as ModelInfo['ref'],
      name: 'Qwen 3.8 27B',
      free: false,
      priceInPerM: 0.1,
      priceOutPerM: 0.1,
    };
    const input = {
      models: [qwen],
      providers: [provider],
      capacity: {
        providers: [provider],
        now: '2026-09-26T12:00:00.000Z',
        tokensPerMinuteRemaining: { [qwen.ref]: 8_000 },
        tokensPerMinuteLimit: { [qwen.ref]: 8_000 },
      },
      profile: autoFree,
      step: 'edit' as const,
      estimate: { inputTokens: 11_000, requiresTools: true },
    };
    expect(scoreModels(input)).toHaveLength(0);
    expect(explainModelRouting(input)[0]?.reasons).toContain(
      'request ~11,000 tokens > Groq 8,000 TPM',
    );
  });

  it('keeps the historical deterministic ordering when provider knobs are at their defaults', () => {
    const geminiProvider = { ...provider, id: 'gemini' as Provider['id'] };
    const groqProvider = { ...provider, id: 'groq' as Provider['id'] };
    const geminiModel = {
      ...model,
      ref: 'gemini/llama' as ModelInfo['ref'],
      providerId: geminiProvider.id,
    };
    const groqModel = {
      ...model,
      ref: 'groq/llama' as ModelInfo['ref'],
      providerId: groqProvider.id,
    };
    const input = {
      models: [groqModel, geminiModel],
      providers: [groqProvider, geminiProvider],
      capacity: { providers: [groqProvider, geminiProvider], now: '2026-09-24T12:00:00.000Z' },
      profile,
      step: 'edit' as const,
      estimate: { inputTokens: 100 },
    };
    let randomCalls = 0;
    const random = () => {
      randomCalls += 1;
      return 0.5;
    };
    const defaults = scoreModels({ ...input, random }).map(({ ref }) => ref);
    expect(defaults).toEqual(['gemini/llama', 'groq/llama']);
    expect(randomCalls).toBe(0);
    randomCalls = 0;
    expect(
      scoreModels({
        ...input,
        routing: { ...DEFAULT_ROUTING_SETTINGS, providerPriorities: {}, providerWeights: {} },
        random,
      }).map(({ ref }) => ref),
    ).toEqual(defaults);
    expect(randomCalls).toBeGreaterThan(0);
  });

  it('keeps default ordering stable across timezones at a UTC day boundary', () => {
    const geminiProvider = { ...provider, id: 'gemini' as Provider['id'] };
    const groqProvider = { ...provider, id: 'groq' as Provider['id'] };
    const geminiModel = {
      ...model,
      ref: 'gemini/llama' as ModelInfo['ref'],
      providerId: geminiProvider.id,
    };
    const groqModel = {
      ...model,
      ref: 'groq/llama' as ModelInfo['ref'],
      providerId: groqProvider.id,
    };
    const originalTz = process.env.TZ;
    const input = {
      models: [groqModel, geminiModel],
      providers: [groqProvider, geminiProvider],
      capacity: {
        providers: [groqProvider, geminiProvider],
        now: '2026-01-15T00:05:00.000Z',
      },
      profile,
      step: 'edit' as const,
      estimate: { inputTokens: 100 },
      routing: DEFAULT_ROUTING_SETTINGS,
      random: () => 0.5,
    };
    try {
      process.env.TZ = 'UTC';
      const utcOffset = new Date(input.capacity.now).getTimezoneOffset();
      const utcOrder = scoreModels(input).map(({ ref }) => ref);

      process.env.TZ = 'America/Los_Angeles';
      const nonUtcOffset = new Date(input.capacity.now).getTimezoneOffset();
      const nonUtcOrder = scoreModels(input).map(({ ref }) => ref);

      expect(utcOffset).toBe(0);
      expect(nonUtcOffset).toBe(480);
      expect(nonUtcOrder).toEqual(utcOrder);
      expect(utcOrder).toEqual(['gemini/llama', 'groq/llama']);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('orders by hard priority tiers and uses seeded weighted sampling for near-equal candidates', () => {
    const geminiProvider = { ...provider, id: 'gemini' as Provider['id'] };
    const groqProvider = { ...provider, id: 'groq' as Provider['id'] };
    const geminiModel = {
      ...model,
      ref: 'gemini/llama' as ModelInfo['ref'],
      providerId: geminiProvider.id,
    };
    const groqModel = {
      ...model,
      ref: 'groq/llama' as ModelInfo['ref'],
      providerId: groqProvider.id,
    };
    const base = {
      models: [geminiModel, groqModel],
      providers: [geminiProvider, groqProvider],
      capacity: { providers: [geminiProvider, groqProvider], now: '2026-09-24T12:00:00.000Z' },
      profile,
      step: 'edit' as const,
      estimate: { inputTokens: 100 },
    };
    expect(
      scoreModels({
        ...base,
        models: [
          { ...geminiModel, quality: 0.2 },
          { ...groqModel, quality: 1 },
        ],
        routing: {
          ...DEFAULT_ROUTING_SETTINGS,
          providerPriorities: { [geminiProvider.id]: 1 },
          providerWeights: {},
        },
      })[0]?.ref,
    ).toBe('gemini/llama');

    let wins = 0;
    for (let seed = 1; seed <= 4_000; seed += 1) {
      let state = seed;
      const random = () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 4_294_967_296;
      };
      const geminiAltModel = {
        ...geminiModel,
        ref: 'gemini/llama-alt' as ModelInfo['ref'],
      };
      if (
        scoreModels({
          ...base,
          models: [...base.models, geminiAltModel],
          routing: {
            ...DEFAULT_ROUTING_SETTINGS,
            smartReliability: false,
            providerPriorities: {},
            providerWeights: { [geminiProvider.id]: 3, [groqProvider.id]: 1 },
          },
          random,
        })[0]?.ref.startsWith('gemini/') === true
      )
        wins += 1;
    }
    expect(wins).toBeGreaterThan(2_880);
    expect(wins).toBeLessThan(3_120);
  });

  it('returns deterministic candidates with an explanation', () => {
    const first = scoreModels({
      models: [model],
      capacity,
      profile,
      step: 'edit',
      estimate: { inputTokens: 100 },
    });
    const second = scoreModels({
      models: [model],
      capacity,
      profile,
      step: 'edit',
      estimate: { inputTokens: 100 },
    });
    expect(first).toEqual(second);
    expect(first[0]?.explanation).toContain('T2 edit');
  });

  it('predicts low-step and TPM exhaustion', () => {
    expect(
      shouldSwitchBeforeStep(
        model,
        { providers: [{ ...provider, stepsLeftToday: 1 }] },
        { inputTokens: 1 },
      ),
    ).toBe(true);
    expect(
      shouldSwitchBeforeStep(
        model,
        { ...capacity, tokensPerMinuteRemaining: { 'groq/llama': 1 } },
        { inputTokens: 2 },
      ),
    ).toBe(true);
  });
});

describe('spend guardrails and simulations', () => {
  it('calculates input and output spend and enforces the smallest active cap', () => {
    const paidModel = { priceInPerM: 2, priceOutPerM: 4 };
    expect(calculateSpend({ inputTokens: 1_000_000, outputTokens: 500_000 }, paidModel)).toBe(4);
    expect(
      canSpend(
        profile,
        { sessionUsd: 0, dayUsd: 4, monthUsd: 0, paidCallsThisSession: 0 },
        { sessionUsd: null, dayUsd: null, monthUsd: null },
        2,
      ),
    ).toBe(false);
  });

  it('prices cached input at the catalog price or configured ratio for spend caps', () => {
    const priced = { priceInPerM: 2, priceOutPerM: 4, priceCachedInPerM: 0.1 };
    expect(
      calculateSpend({ inputTokens: 1_000_000, cachedTokens: 600_000, outputTokens: 0 }, priced),
    ).toBeCloseTo(0.86);
    expect(
      calculateSpend(
        { inputTokens: 1_000_000, cachedTokens: 600_000, outputTokens: 0 },
        { priceInPerM: 2, priceOutPerM: 4, cachedInputRatio: 0.25 },
      ),
    ).toBeCloseTo(1.1);
    expect(
      canSpend(
        { ...profile, paidAllowed: true },
        { sessionUsd: 0, dayUsd: 0, monthUsd: 0, paidCallsThisSession: 0 },
        { sessionUsd: 1.2, dayUsd: null, monthUsd: null },
        calculateSpend(
          { inputTokens: 1_000_000, cachedTokens: 600_000, outputTokens: 0 },
          { priceInPerM: 2, priceOutPerM: 4, cachedInputRatio: 0.25 },
        ),
      ),
    ).toBe(true);
  });

  it('enforces the profile session cap and honors only explicit pre-authorization', () => {
    const capped = { ...profile, caps: { ...profile.caps, sessionUsd: 3 } };
    expect(
      canSpend(
        capped,
        { sessionUsd: 2, dayUsd: 0, monthUsd: 0, paidCallsThisSession: 1 },
        { sessionUsd: null, dayUsd: null, monthUsd: null },
        1.01,
      ),
    ).toBe(false);
    expect(
      requiresConfirmation(
        capped,
        {
          sessionUsd: 0,
          dayUsd: 0,
          monthUsd: 0,
          paidCallsThisSession: 0,
        },
        0.01,
      ),
    ).toBe(true);
    expect(
      requiresConfirmation(
        { ...capped, paidConfirmation: { ...capped.paidConfirmation, preauthorize: true } },
        { sessionUsd: 0, dayUsd: 0, monthUsd: 0, paidCallsThisSession: 0 },
        0.01,
      ),
    ).toBe(false);
  });

  it('describes quota fallback scenarios', () => {
    expect(runSimulationScenarios().map(({ name }) => name)).toEqual([
      'Gemini RPD exhausted',
      'OpenRouter daily exhaustion',
      'Groq TPM overflow',
      'all free exhausted',
    ]);
  });
});

describe('briefing budget properties', () => {
  it('always stays within the requested and model-context budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.string({ maxLength: 2_000 }),
        (budget, recent) => {
          const turns = recent
            ? ([
                { role: 'user' as const, parts: [{ type: 'text' as const, text: recent }] },
              ] as never)
            : [];
          const briefing = buildBriefing(task, turns, model, budget);
          return (
            briefing.tokens <= briefing.limitTokens &&
            briefing.limitTokens <= budget &&
            briefing.limitTokens <= model.contextWindow * 0.5
          );
        },
      ),
    );
  });

  it('never includes a paid model when the spend cap is already exhausted', () => {
    const paid: ModelInfo = {
      ...model,
      ref: 'groq/paid' as ModelInfo['ref'],
      free: false,
      priceInPerM: 1,
      priceOutPerM: 1,
    };
    const paidProvider = { ...provider, tag: 'paid' as const };
    fc.assert(
      fc.property(fc.double({ min: 0, max: 10, noNaN: true }), (spent) => {
        const results = scoreModels({
          models: [paid],
          capacity: {
            providers: [paidProvider],
            now: capacity.now ?? '2026-09-24T12:00:00.000Z',
          },
          providers: [paidProvider],
          profile,
          step: 'edit',
          estimate: { inputTokens: 10_000, outputTokens: 1_000 },
          spend: { sessionUsd: spent, dayUsd: 5, monthUsd: 10, paidCallsThisSession: 0 },
          spendCaps: { sessionUsd: 1, dayUsd: 5, monthUsd: 50 },
        });
        return results.length === 0;
      }),
    );
  });
});
