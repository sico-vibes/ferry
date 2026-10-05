import { describe, expect, it } from 'vitest';
import {
  contextSegments,
  formatMonth,
  formatTokens,
  modalitiesLabel,
  parameterCount,
  priceLabel,
} from './modelFacts';

describe('model facts', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(1_048_576)).toBe('1M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatTokens(131_072)).toBe('131K');
    expect(formatTokens(512)).toBe('512');
  });

  it('reads parameter counts only when the id states them', () => {
    expect(parameterCount('cerebras/gpt-oss-120b')).toBe('120B');
    expect(parameterCount('qwen3-30b-a3b-instruct')).toBe('30B total, 3B active');
    expect(parameterCount('meta-llama/llama-3.3-70b-versatile')).toBe('70B');
    expect(parameterCount('gemini/gemini-3.8-flash')).toBeNull();
    expect(parameterCount('openai/gpt-6-sol')).toBeNull();
  });

  it('formats release months and modalities', () => {
    expect(formatMonth('2025-08-05')).toBe('Aug 2025');
    expect(formatMonth('2024-06')).toBe('Jun 2024');
    expect(formatMonth(undefined)).toBeNull();
    expect(modalitiesLabel(['text', 'image', 'pdf'])).toBe('text, image, PDF');
    expect(modalitiesLabel([])).toBeNull();
  });

  it('scales context windows into ten segments', () => {
    expect(contextSegments(8_192)).toBe(1);
    expect(contextSegments(2_097_152)).toBe(10);
    expect(contextSegments(131_072)).toBeGreaterThan(contextSegments(32_768));
  });

  it('labels free, priced and unpriced models', () => {
    expect(priceLabel({ free: true, priceInPerM: null, priceOutPerM: null })).toBe('Free');
    expect(priceLabel({ free: false, priceInPerM: 0.14, priceOutPerM: 2 })).toBe(
      '$0.14 in, $2 out per 1M',
    );
    expect(priceLabel({ free: false, priceInPerM: null, priceOutPerM: null })).toBe(
      'Paid, price unknown',
    );
  });
});
