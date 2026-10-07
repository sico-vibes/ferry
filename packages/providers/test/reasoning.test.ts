import { describe, expect, it } from 'vitest';
import { ModelInfoSchema } from '@ferry/shared';
import { reasoningProviderOptions, reasoningTransportOptions } from '../src/reasoning.js';

const model = (providerId: string, id = 'thinker', maxOutput = 32_000) =>
  ModelInfoSchema.parse({
    providerId,
    ref: `${providerId}/${id}`,
    name: id,
    tier: 'T1',
    contextWindow: 128_000,
    maxOutput,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    toolCalling: true,
    free: false,
    priceInPerM: null,
    priceOutPerM: null,
  });

describe('reasoning effort provider mapping', () => {
  it('maps OpenAI and OpenRouter efforts in their SDK namespaces', () => {
    expect(reasoningProviderOptions(model('openai'), 'high')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
    expect(reasoningProviderOptions(model('openrouter'), 'medium')).toEqual({
      openrouter: { reasoning: { effort: 'medium' } },
    });
  });
  it.each([
    ['low', 2_000],
    ['medium', 8_000],
    ['high', 24_000],
  ] as const)('maps %s to the specified thinking budget', (effort, budgetTokens) => {
    expect(reasoningProviderOptions(model('anthropic'), effort)).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens } },
    });
    expect(reasoningProviderOptions(model('gemini', 'gemini-2.5-pro'), effort)).toEqual({
      google: { thinkingConfig: { thinkingBudget: budgetTokens } },
    });
  });
  it('caps budgets below output and omits invalid Anthropic budgets', () => {
    expect(reasoningProviderOptions(model('anthropic', 'claude', 4096), 'high')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4095 } },
    });
    expect(reasoningProviderOptions(model('anthropic', 'claude', 1024), 'low')).toEqual({});
  });
  it('maps Gemini 3 levels and transports Google config through the compatible endpoint', () => {
    expect(reasoningProviderOptions(model('gemini', 'gemini-3-pro'), 'medium')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high' } },
    });
    expect(reasoningTransportOptions(model('gemini', 'gemini-2.5-flash'), 'low')).toEqual({
      gemini: { extra_body: { google: { thinking_config: { thinking_budget: 2000 } } } },
    });
  });
  it('sends compatible effort only for advertised levels, and sends nothing for defaults or unsupported selections', () => {
    const supported = model('groq');
    expect(reasoningProviderOptions(supported, 'low')).toEqual({
      groq: { reasoningEffort: 'low' },
    });
    for (const effort of [null, undefined, 'xhigh'] as const)
      expect(reasoningProviderOptions(supported, effort)).toEqual({});
    expect(reasoningProviderOptions({ ...supported, reasoningEfforts: [] }, 'high')).toEqual({});
    expect(reasoningProviderOptions({ ...supported, reasoningEfforts: undefined }, 'high')).toEqual(
      {},
    );
  });
});
