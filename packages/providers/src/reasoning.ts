import type { Effort, ModelInfo } from '@ferry/shared';

import type { streamText } from 'ai';
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
const budgets: Record<Effort, number> = {
  minimal: 1_024,
  low: 2_000,
  medium: 8_000,
  high: 24_000,
  xhigh: 32_000,
  max: 64_000,
};

/** Merge these namespaces with prompt-cache options instead of replacing them. */
export function reasoningProviderOptions(
  model: ModelInfo,
  effort: Effort | null | undefined,
  maxOutput = model.maxOutput,
): ProviderOptions {
  if (!effort || !model.reasoningEfforts?.includes(effort)) return {};
  const budgetTokens = Math.min(budgets[effort], Math.max(0, maxOutput - 1));
  if (model.providerId === 'openai') return { openai: { reasoningEffort: effort } };
  if (
    model.providerId === 'anthropic' ||
    (model.providerId === 'opencode-go' && /\/(?:claude|anthropic)[-/:]/i.test(model.ref))
  ) {
    if (budgetTokens < 1_024) return {};
    return { anthropic: { thinking: { type: 'enabled', budgetTokens } } };
  }
  if (model.providerId === 'gemini' || model.providerId === 'google') {
    const thinkingConfig = /\/gemini-[3-9]/.test(model.ref)
      ? { thinkingLevel: effort === 'medium' && model.ref.includes('pro') ? 'high' : effort }
      : { thinkingBudget: budgetTokens };
    return { google: { thinkingConfig } };
  }
  if (model.providerId === 'openrouter') return { openrouter: { reasoning: { effort } } };
  // Only explicitly advertised models get compatible reasoning_effort (SDK camel-case option).
  return { [model.providerId]: { reasoningEffort: effort } };
}

/** Gemini currently uses the OpenAI-compatible endpoint, which nests Google's config in extra_body. */
export function reasoningTransportOptions(
  model: ModelInfo,
  effort: Effort | null | undefined,
  maxOutput = model.maxOutput,
): ProviderOptions {
  const options = reasoningProviderOptions(model, effort, maxOutput);
  const config = options.google?.thinkingConfig;
  if (!config || model.providerId !== 'gemini') return options;
  const thinking = config as { thinkingBudget?: number; thinkingLevel?: string };
  return {
    gemini: {
      extra_body: {
        google: {
          thinking_config: {
            ...(thinking.thinkingBudget === undefined
              ? {}
              : { thinking_budget: thinking.thinkingBudget }),
            ...(thinking.thinkingLevel === undefined
              ? {}
              : { thinking_level: thinking.thinkingLevel }),
          },
        },
      },
    },
  };
}
