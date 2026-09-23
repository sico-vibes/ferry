import { describe, expect, it } from 'vitest';
import { computeCapacity } from '../src/mock/capacity.js';
import { createProviders } from '../src/mock/fixtures/providers.js';

describe('computeCapacity', () => {
  const now = new Date('2026-09-23T21:47:00.000Z');

  it('computes seeded steps and percentage from fixture budgets', () => {
    const summary = computeCapacity(createProviders(now), now);
    expect(summary.stepsLeftToday).toBe(420);
    expect(summary.percentRemaining).toBe(64);
  });

  it('recomputes from providers that remain enabled and key-valid', () => {
    const providers = createProviders(now);
    const openrouter = providers.find((provider) => provider.id === 'openrouter');
    if (!openrouter) throw new Error('OpenRouter fixture missing');
    openrouter.enabled = false;
    const summary = computeCapacity(providers, now);
    expect(summary.stepsLeftToday).toBe(108);
    expect(summary.percentRemaining).toBe(39);
  });

  it('returns zero capacity and a banner when daily steps are exhausted', () => {
    const providers = createProviders(now).map((provider) =>
      provider.dailyStepBudget === undefined ? provider : { ...provider, stepsLeftToday: 0 },
    );
    const summary = computeCapacity(providers, now);
    expect(summary.stepsLeftToday).toBe(0);
    expect(summary.percentRemaining).toBe(0);
    expect(summary.banner).not.toBeNull();
  });
});
