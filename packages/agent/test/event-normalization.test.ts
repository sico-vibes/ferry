import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  normalizeInlineThinking,
  normalizeReasoningPart,
  reasoningTokensFromUsage,
} from '@ferry/shared';

describe('provider reasoning normalization fixtures', () => {
  it('extracts AI SDK, OpenAI, Gemini, and pi-ai reasoning usage without estimating missing counts', () => {
    expect(reasoningTokensFromUsage({ reasoningTokens: 12 })).toBe(12);
    expect(reasoningTokensFromUsage({ outputTokenDetails: { reasoningTokens: 15 } })).toBe(15);
    expect(reasoningTokensFromUsage({ completion_tokens_details: { reasoning_tokens: 18 } })).toBe(
      18,
    );
    expect(reasoningTokensFromUsage({ thoughtsTokenCount: 20 })).toBe(20);
    expect(reasoningTokensFromUsage({ reasoning: 23 })).toBe(23);
    expect(
      reasoningTokensFromUsage({}, { google: { usageMetadata: { thoughtsTokenCount: 28 } } }),
    ).toBe(28);
    expect(reasoningTokensFromUsage({ outputTokens: 40 })).toBeUndefined();
    expect(reasoningTokensFromUsage({ reasoningTokens: 0 })).toBe(0);
    expect(reasoningTokensFromUsage({ reasoningTokens: -1 })).toBeUndefined();
  });
  it('normalizes AI SDK reasoning, Gemini thought, reasoning_content, and inline think tags', async () => {
    const fixture = new URL(
      '../../testkit/fixtures/agent-events/reasoning-formats.jsonl',
      import.meta.url,
    );
    const rows = (await readFile(fixture, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(normalizeReasoningPart(rows[0])).toBe('native reasoning');
    expect(normalizeReasoningPart(rows[2])).toBe('Gemini thought');
    expect(normalizeReasoningPart(rows[3])).toBe('Provider reasoning payload');
    expect(normalizeReasoningPart(rows[4])).toBe('Reasoning delta');
    const inline = normalizeInlineThinking(typeof rows[1]?.text === 'string' ? rows[1].text : '');
    expect(inline).toEqual({ text: 'visibleanswer', thinking: 'private thought' });
    expect(normalizeReasoningPart({ type: 'text-delta', text: 'plain answer' })).toBeUndefined();
  });
});
