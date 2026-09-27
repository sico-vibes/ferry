import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_SETTINGS,
  ModelInfoSchema,
  ProviderSchema,
  type ModelInfo,
  type Provider,
  type QuotaWindow,
} from '@ferry/shared';
import { BUILTIN_PROFILES, scoreModels, type CapacityView } from '../src/index.js';

const now = '2026-09-27T12:00:00.000Z';
const nowMs = Date.parse(now);
const autoFree = (() => {
  const found = BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free');
  if (!found) throw new Error('missing Auto-Free profile');
  return found;
})();

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function window(remaining: number, limit: number): QuotaWindow {
  return {
    id: 'w',
    scope: 'provider',
    modelRef: null,
    metric: 'tokens',
    kind: 'rolling',
    periodLabel: 'minute',
    used: Math.max(0, limit - remaining),
    limit,
    remaining,
    resetAt: null,
    confidence: 'exact',
  };
}

function provider(id: string, remaining: number): Provider {
  return ProviderSchema.parse({
    id,
    name: id,
    tag: 'legit',
    kind: 'api',
    brand: null,
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
    windows: [window(remaining, 100)],
    stepsLeftToday: 50,
  });
}

function model(ref: string): ModelInfo {
  return ModelInfoSchema.parse({
    ref,
    providerId: ref.slice(0, ref.indexOf('/')),
    name: ref,
    tier: 'T2',
    contextWindow: 100_000,
    maxOutput: 4_000,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
  });
}

const alpha = model('pa/model');
const beta = model('pb/model');

function baseInput(providers: Provider[]): Parameters<typeof scoreModels>[0] {
  const capacity: CapacityView = { providers, now };
  return {
    models: [alpha, beta],
    capacity,
    profile: autoFree,
    step: 'plan',
    estimate: { inputTokens: 100 },
    verifiedModelRefs: [alpha.ref, beta.ref],
  };
}

describe('QA adv: quota headroom ramp scoring', () => {
  it('demotes a low-headroom provider only when the ramp is enabled', () => {
    const providers = [provider('pa', 5), provider('pb', 100)];
    const on = scoreModels({
      ...baseInput(providers),
      routing: { ...DEFAULT_ROUTING_SETTINGS, gentleQuotaRamp: true, smartReliability: false },
    });
    const off = scoreModels({
      ...baseInput(providers),
      routing: { ...DEFAULT_ROUTING_SETTINGS, gentleQuotaRamp: false, smartReliability: false },
    });
    expect(on[0]?.ref).toBe(beta.ref);
    expect(on.find((candidate) => candidate.ref === alpha.ref)?.scoreBreakdown).toMatchObject({
      quotaHeadroomFactor: 0.325,
    });
    expect(off[0]?.ref).toBe(alpha.ref);
    expect(off.find((candidate) => candidate.ref === alpha.ref)?.scoreBreakdown).not.toHaveProperty(
      'quotaHeadroomFactor',
    );
  });

  it('applies custom rampStart and rampFloor', () => {
    const providers = [provider('pa', 25), provider('pb', 100)];
    const ranked = scoreModels({
      ...baseInput(providers),
      routing: {
        ...DEFAULT_ROUTING_SETTINGS,
        gentleQuotaRamp: true,
        smartReliability: false,
        rampStart: 0.5,
        rampFloor: 0,
      },
    });
    expect(ranked.find((candidate) => candidate.ref === alpha.ref)?.scoreBreakdown).toMatchObject({
      quotaHeadroomFactor: 0.5,
    });
  });
});

describe('QA adv: Thompson-sampled reliability scoring', () => {
  const reliability = [
    ...Array.from({ length: 10 }, () => ({
      modelRef: alpha.ref,
      outcome: 'failure' as const,
      at: nowMs,
    })),
    ...Array.from({ length: 10 }, () => ({
      modelRef: beta.ref,
      outcome: 'success' as const,
      at: nowMs,
    })),
  ];

  it('is deterministic for a seeded RNG and prefers the reliable model', () => {
    const providers = [provider('pa', 100), provider('pb', 100)];
    const first = scoreModels({
      ...baseInput(providers),
      routing: { ...DEFAULT_ROUTING_SETTINGS, smartReliability: true },
      reliability,
      random: seededRandom(99),
    });
    const second = scoreModels({
      ...baseInput(providers),
      routing: { ...DEFAULT_ROUTING_SETTINGS, smartReliability: true },
      reliability,
      random: seededRandom(99),
    });
    expect(first.map((candidate) => candidate.ref)).toEqual(
      second.map((candidate) => candidate.ref),
    );
    expect(first[0]?.ref).toBe(beta.ref);
  });

  it('ignores the Thompson sample when the toggle is off', () => {
    const providers = [provider('pa', 100), provider('pb', 100)];
    const random = (): number => {
      throw new Error('random must not be consulted when smartReliability is off');
    };
    expect(() =>
      scoreModels({
        ...baseInput(providers),
        routing: { ...DEFAULT_ROUTING_SETTINGS, smartReliability: false },
        reliability,
        random,
      }),
    ).not.toThrow();
  });
});
