import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ModelInfo, Profile, Provider, TaskRecord } from '@ferry/shared';
import {
  BUILTIN_PROFILES,
  buildBriefing,
  dropReasoningParts,
  normalizeToolCallIds,
  onStepError,
  scoreModels,
  type CapacityView,
} from '../src/index.js';

function profileByName(name: string): Profile {
  const found = BUILTIN_PROFILES.find((item) => item.name === name);
  if (!found) throw new Error(`missing profile ${name}`);
  return found;
}
const best = profileByName('Best Available');
const autoFree = profileByName('Auto-Free');

const now = '2026-09-24T12:00:00.000Z';

function makeProvider(flags: {
  enabled: boolean;
  health: Provider['health'];
  cooldownFuture: boolean;
  keyStatus: Provider['keyStatus'];
  stepsLeftToday: number | null;
}): Provider {
  const cooldownUntil =
    flags.health === 'cooldown'
      ? new Date(
          flags.cooldownFuture ? Date.parse(now) + 60_000 : Date.parse(now) - 60_000,
        ).toISOString()
      : null;
  return {
    id: 'p' as Provider['id'],
    name: 'P',
    tag: 'legit',
    kind: 'api',
    brand: null,
    keyStatus: flags.keyStatus,
    enabled: flags.enabled,
    health: flags.health,
    cooldownUntil,
    dataUse: null,
    termsNote: null,
    signupUrl: null,
    docsUrl: null,
    verifiedAt: null,
    modelCount: 1,
    windows: [],
    stepsLeftToday: flags.stepsLeftToday,
  };
}

const modelSpec = fc.record({
  enabled: fc.boolean(),
  health: fc.constantFrom<Provider['health']>('ok', 'cooldown', 'down', 'unknown'),
  cooldownFuture: fc.boolean(),
  keyStatus: fc.constantFrom<Provider['keyStatus']>(
    'missing',
    'valid',
    'invalid',
    'unchecked',
    'not_applicable',
  ),
  stepsLeftToday: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
  free: fc.boolean(),
  toolCalling: fc.boolean(),
  tier: fc.constantFrom<ModelInfo['tier']>('T1', 'T2', 'T3'),
  contextWindow: fc.integer({ min: 1_000, max: 300_000 }),
  requiresTools: fc.boolean(),
  inputTokens: fc.integer({ min: 1, max: 120_000 }),
});

function expectedEligible(flags: {
  enabled: boolean;
  health: Provider['health'];
  cooldownFuture: boolean;
  keyStatus: Provider['keyStatus'];
  stepsLeftToday: number | null;
  free: boolean;
  toolCalling: boolean;
  tier: ModelInfo['tier'];
  contextWindow: number;
  requiresTools: boolean;
  inputTokens: number;
}): boolean {
  if (!flags.enabled) return false;
  if (flags.health === 'down') return false;
  if (flags.keyStatus === 'missing' || flags.keyStatus === 'invalid') return false;
  if (flags.contextWindow < flags.inputTokens * 1.2) return false;
  if (flags.requiresTools && !flags.toolCalling) return false;
  if (!['T2', 'T3'].includes(flags.tier)) return false;
  if (flags.stepsLeftToday !== null && flags.stepsLeftToday < 1) return false;
  return true;
}

describe('QA router: selection invariants', () => {
  it('selects a model if and only if every eligibility gate passes', () => {
    fc.assert(
      fc.property(modelSpec, (flags) => {
        const provider = makeProvider(flags);
        const model: ModelInfo = {
          ref: 'p/model' as ModelInfo['ref'],
          providerId: provider.id,
          name: 'M',
          tier: flags.tier,
          contextWindow: flags.contextWindow,
          maxOutput: 4_000,
          toolCalling: flags.toolCalling,
          reasoning: false,
          free: flags.free,
          priceInPerM: flags.free ? 0 : 1,
          priceOutPerM: flags.free ? 0 : 1,
        };
        const capacity: CapacityView = { providers: [provider], now };
        const results = scoreModels({
          models: [model],
          capacity,
          profile: best,
          step: 'edit',
          estimate: { inputTokens: flags.inputTokens, requiresTools: flags.requiresTools },
          spend: { sessionUsd: 0, dayUsd: 0, monthUsd: 0, paidCallsThisSession: 9 },
          spendCaps: { sessionUsd: null, dayUsd: null, monthUsd: null },
        });
        const eligible = expectedEligible(flags);
        expect(results.length === 1, JSON.stringify(flags)).toBe(eligible);
        if (results.length > 0) {
          expect(results.filter((candidate) => candidate.selected)).toHaveLength(1);
          expect(results[0]?.selected).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never returns a paid model for a paid-disallowed profile', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom<ModelInfo['tier']>('T1', 'T2', 'T3'),
        (free, tier) => {
          const provider = {
            ...makeProvider({
              enabled: true,
              health: 'ok',
              cooldownFuture: false,
              keyStatus: 'valid',
              stepsLeftToday: 50,
            }),
            tag: 'paid' as const,
          };
          const model: ModelInfo = {
            ref: 'p/model' as ModelInfo['ref'],
            providerId: provider.id,
            name: 'M',
            tier,
            contextWindow: 100_000,
            maxOutput: 4_000,
            toolCalling: true,
            reasoning: false,
            free,
            priceInPerM: free ? 0 : 1,
            priceOutPerM: free ? 0 : 1,
          };
          const results = scoreModels({
            models: [model],
            capacity: { providers: [provider], now },
            profile: autoFree,
            step: 'edit',
            estimate: { inputTokens: 100 },
          });
          return results.length === (free && tier !== 'T1' ? 1 : 0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('keeps one candidate available for a half-open probe when all providers are cooling', () => {
    const provider = makeProvider({
      enabled: true,
      health: 'cooldown',
      cooldownFuture: true,
      keyStatus: 'valid',
      stepsLeftToday: 50,
    });
    const model: ModelInfo = {
      ref: 'p/model' as ModelInfo['ref'],
      providerId: provider.id,
      name: 'M',
      tier: 'T2',
      contextWindow: 100_000,
      maxOutput: 4_000,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    };
    const results = scoreModels({
      models: [model],
      capacity: { providers: [provider], now },
      profile: best,
      step: 'edit',
      estimate: { inputTokens: 100 },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.selected).toBe(true);
  });

  it('still surfaces a half-open candidate when capacity.now is malformed', () => {
    const provider = makeProvider({
      enabled: true,
      health: 'cooldown',
      cooldownFuture: true,
      keyStatus: 'valid',
      stepsLeftToday: 50,
    });
    const model: ModelInfo = {
      ref: 'p/model' as ModelInfo['ref'],
      providerId: provider.id,
      name: 'M',
      tier: 'T2',
      contextWindow: 100_000,
      maxOutput: 4_000,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    };
    const results = scoreModels({
      models: [model],
      capacity: { providers: [provider], now: 'not-a-date' },
      profile: best,
      step: 'edit',
      estimate: { inputTokens: 100 },
    });
    expect(results).toHaveLength(1);
  });
});

describe('QA router: deterministic output', () => {
  it('ranks preferred direct coding models ahead of preferred OpenRouter free minis', () => {
    const refs = [
      'openrouter/cohere/north-mini-code:free',
      'google/gemini-3.8-flash',
      'groq/qwen/qwen3.8-27b',
      'mistral/codestral-2508',
      'cerebras/gpt-oss-120b',
    ];
    const providers: Provider[] = refs.map((ref) => {
      const providerId = ref.slice(0, ref.indexOf('/')) as Provider['id'];
      const provider = makeProvider({
        enabled: true,
        health: 'ok',
        cooldownFuture: false,
        keyStatus: 'valid',
        stepsLeftToday: 50,
      });
      provider.id = providerId;
      return provider;
    });
    const models: ModelInfo[] = refs.map((ref) => {
      const providerId = ref.slice(0, ref.indexOf('/')) as Provider['id'];
      return {
        ref: ref as ModelInfo['ref'],
        providerId,
        name: ref,
        tier: 'T2',
        contextWindow: 100_000,
        maxOutput: 4_000,
        toolCalling: true,
        reasoning: false,
        free: true,
        priceInPerM: 0,
        priceOutPerM: 0,
      };
    });
    const ranked = scoreModels({
      models,
      capacity: { providers, now },
      profile: best,
      step: 'edit',
      estimate: { inputTokens: 1_000, requiresTools: true },
      preferredModelRefs: ['openrouter/cohere/north-mini-code:free'],
    });
    expect(ranked[0]?.ref).not.toBe('openrouter/cohere/north-mini-code:free');
    expect(ranked.map(({ ref }) => ref)).toEqual(expect.arrayContaining(refs));
  });

  it('is stable and tie-breaks by ref', () => {
    const providers: Provider[] = ['a', 'b'].map(() =>
      makeProvider({
        enabled: true,
        health: 'ok',
        cooldownFuture: false,
        keyStatus: 'valid',
        stepsLeftToday: 50,
      }),
    );
    providers.forEach((provider, index) => {
      provider.id = (index === 0 ? 'a' : 'b') as Provider['id'];
    });
    const models: ModelInfo[] = providers.map((provider) => ({
      ref: `${provider.id}/model` as ModelInfo['ref'],
      providerId: provider.id,
      name: 'M',
      tier: 'T2',
      contextWindow: 100_000,
      maxOutput: 4_000,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    }));
    const run = () =>
      scoreModels({
        models,
        capacity: { providers, now },
        profile: best,
        step: 'edit',
        estimate: { inputTokens: 100 },
      });
    expect(run()).toEqual(run());
    expect(run().map((candidate) => candidate.ref)).toEqual(['a/model', 'b/model']);
  });
});

describe('QA router: briefing budget under hostile sizes', () => {
  const model: ModelInfo = {
    ref: 'p/model' as ModelInfo['ref'],
    providerId: 'p' as ModelInfo['providerId'],
    name: 'M',
    tier: 'T2',
    contextWindow: 8_192,
    maxOutput: 4_000,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
  };
  it('never exceeds the requested or context budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000 }),
        fc.string({ maxLength: 4_000 }),
        fc.string({ maxLength: 4_000 }),
        (budget, goal, turn) => {
          const task: TaskRecord = {
            sessionId: 'session_1' as TaskRecord['sessionId'],
            goal,
            plan: [{ id: '1', text: turn, status: 'doing' }],
            decisions: [{ text: turn, why: goal, at: now }],
            touchedFiles: [{ path: goal, purpose: turn }],
            nextStep: turn,
          };
          const turns = [
            { role: 'user' as const, parts: [{ type: 'text' as const, text: turn }] },
          ] as never;
          const briefing = buildBriefing(task, turns, model, budget);
          return (
            briefing.tokens <= briefing.limitTokens &&
            briefing.limitTokens <= budget &&
            briefing.limitTokens <= model.contextWindow * 0.5 &&
            briefing.tokens >= 0
          );
        },
      ),
      { numRuns: 150 },
    );
  });

  it('returns an empty briefing when the budget is zero', () => {
    const task: TaskRecord = {
      sessionId: 'session_1' as TaskRecord['sessionId'],
      goal: 'x'.repeat(1_000),
      plan: [],
      decisions: [],
      touchedFiles: [],
      nextStep: null,
    };
    const briefing = buildBriefing(task, [], model, 0);
    expect(briefing.tokens).toBe(0);
    expect(briefing.text).toBe('');
  });
});

describe('QA router: message normalization', () => {
  it('sanitizes Gemini tool-call ids and drops reasoning when unsupported', () => {
    const parts = [
      { type: 'tool_call' as const, id: 'call.a/b', callId: 'call.1' },
      { type: 'reasoning' as const, text: 'why' },
    ];
    const gemini = normalizeToolCallIds(parts, 'gemini');
    expect(gemini[0]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(dropReasoningParts(parts, false)).toHaveLength(1);
    expect(dropReasoningParts(parts, true)).toHaveLength(2);
  });

  it('retries only short explicit rate-limit delays', () => {
    expect(onStepError({ kind: 'rate_limit', retryAfterSeconds: 5 })).toEqual({
      action: 'retry_same',
      attempts: 1,
    });
    expect(onStepError({ kind: 'rate_limit', retryAfterSeconds: 11 }).action).toBe('reselect');
    expect(onStepError({ kind: 'rate_limit', retryAfterSeconds: null }).action).toBe('reselect');
    expect(onStepError({ kind: 'provider' }).action).toBe('reselect');
  });
});
