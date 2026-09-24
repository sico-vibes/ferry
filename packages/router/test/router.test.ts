import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ModelInfo, Profile, Provider, TaskRecord } from '@ferry/shared';
import {
  BUILTIN_PROFILES,
  buildBriefing,
  calculateSpend,
  canSpend,
  classifyStep,
  runSimulationScenarios,
  scoreModels,
  shouldSwitchBeforeStep,
  type CapacityView,
} from '../src/index.js';

const profileResult = BUILTIN_PROFILES.find((item) => item.name === 'Best Available');
if (!profileResult) throw new Error('Best Available profile fixture is missing');
const profile: Profile = profileResult;
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
    fc.assert(
      fc.property(fc.double({ min: 0, max: 10, noNaN: true }), (spent) => {
        const results = scoreModels({
          models: [paid],
          capacity,
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
