import { ProviderIdSchema } from '@ferry/shared';
import type { FallbackChainEntry, ModelInfo, Profile, Provider, StepKind } from '@ferry/shared';
import type { CapacityView } from './index.js';
import { explainModelRouting, scoreModels } from './index.js';

const provider = (id: string) => ProviderIdSchema.parse(id);

/** Default deterministic chain, mirrored by data/auto-free-chain.yaml. */
export const DEFAULT_AUTO_FREE_CHAIN: readonly FallbackChainEntry[] = [
  {
    provider: provider('gemini'),
    patterns: ['gemini-3.8-flash', 'gemini-3.*-flash', 'gemini-flash-latest'],
  },
  { provider: provider('groq'), patterns: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'] },
  { provider: provider('cerebras'), patterns: ['gpt-oss-120b', 'qwen-3.8-27b'] },
  { provider: provider('mistral'), patterns: ['codestral-*', 'devstral-*', 'mistral-medium*'] },
  {
    provider: provider('sambanova'),
    patterns: ['gpt-oss-120b', 'DeepSeek-R1', 'Qwen3.8-32B', 'Meta-Llama-3.3-70B-Instruct'],
  },
  { provider: provider('nvidia'), patterns: ['nvidia/nemotron-3-super-*'] },
  {
    provider: provider('openrouter'),
    patterns: [
      'qwen/qwen3.8-27b:free',
      'deepseek/*:free',
      'z-ai/glm*:free',
      'openai/gpt-oss-120b:free',
    ],
  },
  {
    provider: provider('kilo'),
    patterns: ['qwen/qwen3.8-27b:free', 'deepseek/*:free', 'openai/gpt-oss-120b:free'],
  },
];

export type ChainSkipReason =
  | 'not_live'
  | 'cooling'
  | 'no_key'
  | 'tools_unsupported'
  | 'excluded_name'
  | 'ineligible'
  | 'available';

export interface ChainDiagnostic {
  provider: string;
  pattern: string;
  status: ChainSkipReason | 'hit';
  modelRef: string | null;
  detail: string;
}

export interface ResolvedFallbackChain {
  models: ModelInfo[];
  diagnostics: ChainDiagnostic[];
  hit: { provider: string; pattern: string; modelRef: string } | null;
}

const excludedName =
  /(?:preview|experimental|\blive\b|\baqa\b|deep-research|image|lyria|tts|audio|embedding|guard|omni|nano|robotics|medical|health|finance|legal|(?:^|[-/])fin(?:[-/:.]|$)|(?:^|[-/])sante(?:[-/:.]|$))/i;

export function isStrictFallbackNameEligible(
  model: ModelInfo,
  verifiedModelRefs: readonly string[],
): boolean {
  if (!excludedName.test(`${model.ref} ${model.name}`)) return true;
  return model.toolCalling && verifiedModelRefs.includes(model.ref);
}

function matchesPattern(model: ModelInfo, pattern: string): boolean {
  const modelId = model.ref.slice(model.providerId.length + 1);
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'i').test(modelId);
}

function providerFor(providers: readonly Provider[], providerId: string): Provider | undefined {
  return providers.find((provider) => provider.id === providerId);
}

/** Resolve user patterns against the current provider model cache in declared order. */
export function resolveFallbackChain(input: {
  chain: readonly FallbackChainEntry[];
  models: readonly ModelInfo[];
  capacity: CapacityView;
  profile: Profile;
  step?: StepKind;
  inputTokens: number;
  verifiedModelRefs?: readonly string[];
  now?: number;
}): ResolvedFallbackChain {
  const now = input.now ?? Date.parse(input.capacity.now ?? new Date().toISOString());
  const verified = input.verifiedModelRefs ?? [];
  const diagnostics: ChainDiagnostic[] = [];
  const models: ModelInfo[] = [];
  const added = new Set<string>();
  let hit: ResolvedFallbackChain['hit'] = null;
  for (const entry of input.chain) {
    for (const pattern of entry.patterns) {
      const provider = providerFor(input.capacity.providers, entry.provider);
      if (
        !provider ||
        !provider.enabled ||
        (provider.keyStatus === 'missing' && provider.keyRequired !== false) ||
        provider.keyStatus === 'invalid'
      ) {
        diagnostics.push({
          provider: entry.provider,
          pattern,
          status: 'no_key',
          modelRef: null,
          detail: 'Provider has no configured usable key.',
        });
        continue;
      }
      const matching = input.models.filter(
        (model) => model.providerId === entry.provider && matchesPattern(model, pattern),
      );
      if (!matching.length) {
        diagnostics.push({
          provider: entry.provider,
          pattern,
          status: 'not_live',
          modelRef: null,
          detail: 'Pattern did not match a live model.',
        });
        continue;
      }
      const eligible: ModelInfo[] = [];
      let coolingUntil: string | null = null;
      for (const model of matching) {
        if (provider.cooldownUntil && Date.parse(provider.cooldownUntil) > now) {
          coolingUntil = provider.cooldownUntil;
          continue;
        }
        if (!model.toolCalling) {
          diagnostics.push({
            provider: entry.provider,
            pattern,
            status: 'tools_unsupported',
            modelRef: model.ref,
            detail: 'Model does not support tool calling.',
          });
          continue;
        }
        if (!isStrictFallbackNameEligible(model, verified)) {
          diagnostics.push({
            provider: entry.provider,
            pattern,
            status: 'excluded_name',
            modelRef: model.ref,
            detail: 'Name is excluded from automatic coding routes unless verified for tools.',
          });
          continue;
        }
        const scoreInput = {
          models: [model],
          capacity: input.capacity,
          profile: input.profile,
          step: input.step ?? 'plan',
          estimate: { inputTokens: input.inputTokens, requiresTools: true },
          verifiedModelRefs: verified,
        } as const;
        if (!scoreModels(scoreInput).length) {
          const reasons = explainModelRouting(scoreInput).flatMap((row) => row.reasons);
          diagnostics.push({
            provider: entry.provider,
            pattern,
            status: 'ineligible',
            modelRef: model.ref,
            detail: reasons.length
              ? reasons.join('; ')
              : 'Model did not pass routing eligibility checks.',
          });
          continue;
        }
        eligible.push(model);
      }
      if (!eligible.length && coolingUntil) {
        diagnostics.push({
          provider: entry.provider,
          pattern,
          status: 'cooling',
          modelRef: matching[0]?.ref ?? null,
          detail: `Provider cooling until ${coolingUntil}.`,
        });
        continue;
      }
      for (const model of eligible) {
        if (added.has(model.ref)) continue;
        added.add(model.ref);
        models.push(model);
      }
      const first = eligible[0];
      if (first) {
        const status = hit ? 'available' : 'hit';
        diagnostics.push({
          provider: entry.provider,
          pattern,
          status,
          modelRef: first.ref,
          detail:
            status === 'hit'
              ? 'First eligible live chain model.'
              : 'Eligible later chain fallback.',
        });
        hit ??= { provider: entry.provider, pattern, modelRef: first.ref };
      } else if (
        !diagnostics.some((row) => row.provider === entry.provider && row.pattern === pattern)
      ) {
        diagnostics.push({
          provider: entry.provider,
          pattern,
          status: 'ineligible',
          modelRef: null,
          detail: 'No eligible model matched this pattern.',
        });
      }
    }
  }
  return { models, diagnostics, hit };
}

export function chainForProfile(profile: Profile): readonly FallbackChainEntry[] {
  if (profile.fallbackChain) return profile.fallbackChain;
  return profile.name === 'Auto-Free' || profile.name === 'Best Available'
    ? DEFAULT_AUTO_FREE_CHAIN
    : [];
}
