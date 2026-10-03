import { describe, expect, it } from 'vitest';
import {
  StickySessionLedger,
  preferStickyAffinity,
  canProbeCooldown,
  decayedBetaPosterior,
  headroomFactor,
  isToolDeferred,
  sampleBeta,
  shouldRetireModel,
} from '../src/index.js';

describe('FreeLLMAPI-inspired routing techniques', () => {
  it('keeps sticky routes until their configured TTL expires and supports disabled routing', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    const ledger = new StickySessionLedger();
    ledger.set('session-a', 'gemini/flash', now, 30 * 60_000);
    expect(ledger.get('session-a', now + 29 * 60_000)).toBe('gemini/flash');
    expect(ledger.get('session-a', now + 30 * 60_000)).toBeUndefined();
    // With the setting off, callers do not consult or update this ledger.
    expect(new StickySessionLedger().get('session-a', now)).toBeUndefined();
  });

  it('keeps provider key affinity and releases it when the route fails', () => {
    const ledger = new StickySessionLedger();
    ledger.set('session-a', 'groq/llama', 10, 60_000, {
      providerId: 'groq',
      providerKeyId: 'provider-key-1',
    });
    expect(ledger.getRoute('session-a', 11)).toEqual({
      modelRef: 'groq/llama',
      providerId: 'groq',
      providerKeyId: 'provider-key-1',
      expiresAt: 60_010,
    });
    const candidates = [
      { ref: 'gemini/flash', providerId: 'gemini' },
      { ref: 'groq/llama', providerId: 'groq' },
    ];
    expect(
      preferStickyAffinity(candidates, ledger.getRoute('session-a', 11), 'soft', () => undefined)[0]
        ?.ref,
    ).toBe('groq/llama');
    expect(
      preferStickyAffinity(
        candidates,
        ledger.getRoute('session-a', 11),
        'strict',
        () => undefined,
      ).map(({ ref }) => ref),
    ).toEqual(['groq/llama']);
    // AgentLoop clears the ledger in its provider-error path, which releases soft and strict affinity.
    ledger.clear('session-a');
    expect(ledger.getRoute('session-a', 11)).toBeUndefined();
    expect(
      preferStickyAffinity(
        candidates,
        ledger.getRoute('session-a', 11),
        'strict',
        () => undefined,
      ).map(({ ref }) => ref),
    ).toEqual(['gemini/flash', 'groq/llama']);
  });

  it('decays reliability over seven days with a two-day half-life and samples the Beta prior', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    const posterior = decayedBetaPosterior(
      [
        { modelRef: 'm', outcome: 'success', at: now },
        { modelRef: 'm', outcome: 'failure', at: now - 2 * 86_400_000 },
        { modelRef: 'm', outcome: 'failure', at: now - 8 * 86_400_000 },
      ],
      'm',
      now,
    );
    expect(posterior).toEqual({ alpha: 2, beta: 1.5 });
    expect(sampleBeta(posterior, () => 0.5)).toBeGreaterThanOrEqual(0);
    expect(sampleBeta(posterior, () => 0.5)).toBeLessThanOrEqual(1);
    expect(decayedBetaPosterior([], 'm', now)).toEqual({ alpha: 1, beta: 1 });
  });

  it('probes only heuristic cooldowns close to their reset time', () => {
    const now = 10_000;
    expect(canProbeCooldown({ provenance: 'heuristic', until: now + 30_000 }, now)).toBe(true);
    expect(canProbeCooldown({ provenance: 'authoritative', until: now + 10_000 }, now)).toBe(false);
    expect(canProbeCooldown({ provenance: 'credit', until: now }, now)).toBe(false);
    expect(canProbeCooldown({ provenance: 'tier', until: now }, now)).toBe(false);
  });

  it('ramps down quota headroom while the disabled path keeps full weight', () => {
    expect(headroomFactor(20, 100)).toBe(1);
    expect(headroomFactor(10, 100)).toBeCloseTo(0.55);
    expect(headroomFactor(0, 100)).toBe(0.1);
    const enabled = headroomFactor(10, 100, 0.2, 0.1);
    const disabled = 1;
    expect(enabled).toBeLessThan(disabled);
  });

  it('defers tool-rejecting models after three distinct requests and expires old evidence', () => {
    const rejections = [1, 2, 3].map((number) => ({
      modelRef: 'm',
      requestId: `request-${String(number)}`,
      at: 100_000,
    }));
    expect(isToolDeferred(rejections, 'm', 101_000)).toBe(true);
    expect(isToolDeferred(rejections.slice(0, 2), 'm', 101_000)).toBe(false);
    expect(isToolDeferred(rejections, 'm', 3_800_001)).toBe(false);
    // With the setting off, selection skips the deferral check.
    expect(isToolDeferred([], 'm', 101_000)).toBe(false);
  });

  it('requires corroboration for probable retirement and accepts definitive EOL signals', () => {
    const now = 100_000;
    const failures = [{ modelRef: 'm', requestId: 'request-a', at: now }];
    expect(shouldRetireModel(404, 'model not found', failures, 'm', 'request-b', now + 1)).toBe(
      true,
    );
    expect(shouldRetireModel(404, 'model not found', [], 'm', 'request-b', now)).toBe(false);
    expect(shouldRetireModel(410, 'gone', [], 'm', 'request-b', now)).toBe(true);
    expect(shouldRetireModel(404, 'not found', failures, 'm', 'request-b', now + 3_600_001)).toBe(
      false,
    );
  });
});
