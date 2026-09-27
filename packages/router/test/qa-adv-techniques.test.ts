import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_SETTINGS } from '@ferry/shared';
import {
  StickySessionLedger,
  canProbeCooldown,
  decayedBetaPosterior,
  headroomFactor,
  isToolDeferred,
  sampleBeta,
  shouldRetireModel,
} from '../src/index.js';
import { routingTechniqueEnabled } from '../src/techniques.js';

/** Deterministic PRNG so Thompson-sampling tests are reproducible. */
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

const DAY = 24 * 60 * 60 * 1000;

describe('QA adv: sticky session ledger', () => {
  it('expires routes at the TTL boundary and never resurrects cleared routes', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    const ledger = new StickySessionLedger();
    ledger.set('session-a', 'gemini/flash', now, 30 * 60_000);
    expect(ledger.get('session-a', now + 29 * 60_000)).toBe('gemini/flash');
    expect(ledger.get('session-a', now + 29 * 60_000 + 59_999)).toBe('gemini/flash');
    expect(ledger.get('session-a', now + 30 * 60_000)).toBeUndefined();
    expect(ledger.get('session-a', now)).toBeUndefined();
    ledger.set('session-a', 'groq/llama', now, 60_000);
    ledger.clear('session-a');
    expect(ledger.get('session-a', now)).toBeUndefined();
    expect(ledger.snapshot()).toEqual({});
  });

  it('restores persisted routes and drops them once expired', () => {
    const now = 1_000_000;
    const ledger = new StickySessionLedger({
      s: { modelRef: 'm/model', expiresAt: now + 5_000 },
      stale: { modelRef: 'm/old', expiresAt: now - 1 },
    });
    expect(ledger.get('s', now)).toBe('m/model');
    expect(ledger.get('stale', now)).toBeUndefined();
    expect(ledger.get('s', now + 5_001)).toBeUndefined();
  });
});

describe('QA adv: decay-weighted Beta reliability', () => {
  it('applies a two-day half-life over a seven-day window and ignores future rows', () => {
    const now = 8 * DAY;
    const posterior = decayedBetaPosterior(
      [
        { modelRef: 'm', outcome: 'success', at: now },
        { modelRef: 'm', outcome: 'failure', at: now - 2 * DAY },
        { modelRef: 'm', outcome: 'failure', at: now - 8 * DAY },
        { modelRef: 'other', outcome: 'failure', at: now },
        { modelRef: 'm', outcome: 'success', at: now + 1 },
      ],
      'm',
      now,
    );
    expect(posterior).toEqual({ alpha: 2, beta: 1.5 });
    expect(decayedBetaPosterior([], 'm', now)).toEqual({ alpha: 1, beta: 1 });
    expect(
      decayedBetaPosterior(
        [{ modelRef: 'm', outcome: 'success', at: now - 7 * DAY - 1 }],
        'm',
        now,
      ),
    ).toEqual({ alpha: 1, beta: 1 });
    expect(
      decayedBetaPosterior([{ modelRef: 'm', outcome: 'success', at: now - 7 * DAY }], 'm', now)
        .alpha,
    ).toBeCloseTo(1 + 0.5 ** 3.5, 10);
  });

  it('samples Beta deterministically for a seeded RNG', () => {
    const posterior = { alpha: 3, beta: 5 };
    const first = sampleBeta(posterior, seededRandom(42));
    const second = sampleBeta(posterior, seededRandom(42));
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(1);
    expect(sampleBeta({ alpha: 1, beta: 1 }, seededRandom(7))).toBe(
      sampleBeta({ alpha: 1, beta: 1 }, seededRandom(7)),
    );
  });
});

describe('QA adv: headroom ramp', () => {
  it('ramps from the start fraction to the floor without going negative', () => {
    expect(headroomFactor(20, 100)).toBe(1);
    expect(headroomFactor(100, 100)).toBe(1);
    expect(headroomFactor(0, 100)).toBe(0.1);
    expect(headroomFactor(-25, 100)).toBe(0.1);
    expect(headroomFactor(5, 100)).toBeCloseTo(0.325, 10);
    expect(headroomFactor(10, 100)).toBeCloseTo(0.55, 10);
    expect(headroomFactor(null, 100)).toBe(1);
    expect(headroomFactor(10, null)).toBe(1);
  });

  it('honours custom start/floor at their boundaries', () => {
    expect(headroomFactor(50, 100, 0.5, 0)).toBe(1);
    expect(headroomFactor(25, 100, 0.5, 0)).toBe(0.5);
    expect(headroomFactor(0, 100, 0.5, 0)).toBe(0);
  });
});

describe('QA adv: tool-rejection deferral', () => {
  const now = 2_000_000;
  const rejection = (requestId: string, at = now - 1_000) => ({ modelRef: 'm', requestId, at });

  it('requires three distinct requests inside the one-hour evidence window', () => {
    expect(isToolDeferred([rejection('a'), rejection('b'), rejection('c')], 'm', now)).toBe(true);
    expect(isToolDeferred([rejection('a'), rejection('a'), rejection('a')], 'm', now)).toBe(false);
    expect(isToolDeferred([rejection('a'), rejection('b')], 'm', now)).toBe(false);
    expect(isToolDeferred([rejection('a'), rejection('b'), rejection('c')], 'other', now)).toBe(
      false,
    );
    expect(
      isToolDeferred([rejection('a', now - 3_599_000), rejection('b'), rejection('c')], 'm', now),
    ).toBe(true);
    expect(
      isToolDeferred([rejection('a', now - 3_600_001), rejection('b'), rejection('c')], 'm', now),
    ).toBe(false);
  });

  it('BUG: future-dated tool rejections count as fresh after the clock jumps backwards', () => {
    // A backwards clock (NTP/DST) must not extend a tool bench indefinitely.
    const future = [
      rejection('a', now + 60_000),
      rejection('b', now + 60_000),
      rejection('c', now + 60_000),
    ];
    expect(isToolDeferred(future, 'm', now)).toBe(false);
  });
});

describe('QA adv: model-retirement corroboration', () => {
  const now = 3_000_000;
  const failure = (requestId: string, at = now - 1_000) => ({ modelRef: 'm', requestId, at });

  it('retires on a single definitive signal but corroborates probable 404s', () => {
    expect(shouldRetireModel(410, 'gone', [], 'm', 'r2', now)).toBe(true);
    expect(shouldRetireModel(404, 'model has reached end of life', [], 'm', 'r2', now)).toBe(true);
    expect(shouldRetireModel(404, 'model not found', [], 'm', 'r2', now)).toBe(false);
    expect(shouldRetireModel(404, 'model not found', [failure('r1')], 'm', 'r2', now)).toBe(true);
    expect(shouldRetireModel(404, 'model not found', [failure('r2')], 'm', 'r2', now)).toBe(false);
    expect(
      shouldRetireModel(404, 'model not found', [failure('r1', now - 3_600_001)], 'm', 'r2', now),
    ).toBe(false);
    expect(shouldRetireModel(200, 'ok', [failure('r1')], 'm', 'r2', now)).toBe(false);
  });

  it('BUG: a single transient 404 with a future timestamp falsely corroborates retirement', () => {
    // One flaky 404 must never retire a model; a backwards clock currently
    // makes the sole failure look "recent" and satisfies corroboration.
    const future = [failure('r1', now + 60_000)];
    expect(shouldRetireModel(404, 'model not found', future, 'm', 'r2', now)).toBe(false);
  });
});

describe('QA adv: cooldown provenance probes', () => {
  it('probes only heuristic cooldowns within the probe window', () => {
    const now = 500_000;
    expect(canProbeCooldown({ provenance: 'heuristic', until: now + 60_000 }, now)).toBe(true);
    expect(canProbeCooldown({ provenance: 'heuristic', until: now + 60_001 }, now)).toBe(false);
    expect(canProbeCooldown({ provenance: 'heuristic', until: now - 1 }, now)).toBe(true);
    expect(canProbeCooldown({ provenance: 'authoritative', until: now }, now)).toBe(false);
    expect(canProbeCooldown({ provenance: 'credit', until: now }, now)).toBe(false);
    expect(canProbeCooldown({ provenance: 'tier', until: now }, now)).toBe(false);
  });
});

describe('QA adv: technique toggles', () => {
  it('reads toggle state directly from routing settings', () => {
    expect(routingTechniqueEnabled(DEFAULT_ROUTING_SETTINGS, 'stickySessions')).toBe(true);
    expect(routingTechniqueEnabled(DEFAULT_ROUTING_SETTINGS, 'smartReliability')).toBe(true);
    expect(routingTechniqueEnabled(DEFAULT_ROUTING_SETTINGS, 'gentleQuotaRamp')).toBe(true);
    expect(routingTechniqueEnabled(DEFAULT_ROUTING_SETTINGS, 'toolRejectionMemory')).toBe(true);
    expect(routingTechniqueEnabled(DEFAULT_ROUTING_SETTINGS, 'carefulModelRetirement')).toBe(true);
    const off = { ...DEFAULT_ROUTING_SETTINGS, stickySessions: false };
    expect(routingTechniqueEnabled(off, 'stickySessions')).toBe(false);
    expect(routingTechniqueEnabled(off, 'smartReliability')).toBe(true);
  });
});
