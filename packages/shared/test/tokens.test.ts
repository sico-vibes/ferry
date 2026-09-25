import { describe, expect, it } from 'vitest';
import { estimateTokens, updateTokenCorrectionFactor } from '../src/tokens/index.js';

describe('token estimator', () => {
  it('counts text and chat messages', () => {
    expect(estimateTokens('hello')).toBeGreaterThan(0);
    expect(estimateTokens([{ role: 'user', content: 'hello' }])).toBeGreaterThan(0);
  });
  it('applies model correction factors and updates them with EMA', () => {
    expect(estimateTokens('hello', 'family', { family: 2 })).toBeGreaterThan(
      estimateTokens('hello'),
    );
    expect(updateTokenCorrectionFactor(1, 100, 150, 0.2)).toBe(1.1);
    expect(updateTokenCorrectionFactor(undefined, 100, 120)).toBe(1.2);
  });
});
