import { describe, expect, it } from 'vitest';
import { gatewayRoutingMode, moveItem, toggleModel } from './modelSelection';

describe('gateway model selection', () => {
  it('appends new models and keeps logical entries', () => {
    expect(toggleModel(['auto-free', 'groq/a'], 'gemini/b', true)).toEqual([
      'auto-free',
      'groq/a',
      'gemini/b',
    ]);
    expect(toggleModel(['groq/a'], 'groq/a', true)).toEqual(['groq/a']);
    expect(toggleModel(['groq/a', 'gemini/b'], 'groq/a', false)).toEqual(['gemini/b']);
  });

  it('reorders within bounds only', () => {
    expect(moveItem(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 'b', 1)).toEqual(['a', 'b']);
  });

  it('treats the none profile as model routing', () => {
    expect(gatewayRoutingMode('none')).toBe('models');
    expect(gatewayRoutingMode('auto-free')).toBe('profile');
  });
});
