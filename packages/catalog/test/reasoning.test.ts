import { describe, expect, it } from 'vitest';
import {
  buildCapabilityRegistry,
  normalizeCapability,
  reasoningEffortsForModel,
} from '../src/index.js';

describe('reasoning effort discovery', () => {
  it('does not copy effort support between providers of the same model', () => {
    const registry = buildCapabilityRegistry([
      { provider: 'openai', id: 'gpt-5', modelsDev: { reasoning: true } },
      { provider: 'custom', id: 'gpt-5', modelsDev: { reasoning: true } },
    ]);
    expect(registry['openai/gpt-5']?.reasoningEfforts).toContain('minimal');
    expect(registry['custom/gpt-5']?.reasoningEfforts).toEqual([]);
  });
  it.each(['reasoning', 'reasoning_effort', 'include_reasoning'])(
    'recognizes %s metadata',
    (parameter) => {
      expect(
        normalizeCapability({
          provider: 'custom',
          id: 'thinker',
          live: { supported_parameters: [parameter] },
        }).reasoningEfforts,
      ).toEqual(['low', 'medium', 'high']);
    },
  );
  it('uses documented family defaults and minimal only on original GPT-5 models', () => {
    expect(reasoningEffortsForModel({ provider: 'openai', id: 'o3' })).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(reasoningEffortsForModel({ provider: 'openai', id: 'gpt-5-mini' })).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(reasoningEffortsForModel({ provider: 'openai', id: 'gpt-5.4' })).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(
      reasoningEffortsForModel({ provider: 'anthropic', id: 'claude-sonnet-4', reasoning: true }),
    ).toEqual(['low', 'medium', 'high']);
    expect(reasoningEffortsForModel({ provider: 'gemini', id: 'gemini-2.5-flash' })).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(reasoningEffortsForModel({ provider: 'custom', id: 'o3', reasoning: true })).toEqual([]);
  });
  it('honors explicit empty, supported, and unsupported live effort metadata', () => {
    expect(
      reasoningEffortsForModel({
        provider: 'openai',
        id: 'gpt-5',
        metadata: { supported_parameters: ['tools'] },
      }),
    ).toEqual([]);
    expect(
      reasoningEffortsForModel({
        provider: 'openai',
        id: 'gpt-5',
        metadata: { reasoningEfforts: [] },
      }),
    ).toEqual([]);
    expect(
      reasoningEffortsForModel({
        provider: 'openai',
        id: 'gpt-5',
        metadata: { reasoning_efforts: ['high', 'xhigh', 'max', 'invalid'] },
      }),
    ).toEqual(['high', 'xhigh', 'max']);
  });
});
