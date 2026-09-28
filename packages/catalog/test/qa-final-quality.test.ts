import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isSafetyFilteredModel,
  loadQualityPriors,
  qualityPenaltyForModel,
  rankFreeCodingModels,
  type QualityPrior,
} from '../src/index.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function prior(score: number, confidence: number): QualityPrior {
  return {
    score,
    confidence,
    aiderCoding: null,
    wellFormed: null,
    bfclOverall: null,
    bfclLive: null,
    datasetDate: null,
    aiderDate: null,
    bfclDate: null,
    sources: [],
  };
}

describe('QA final: quality priors stay finite and bounded', () => {
  it('never produces NaN or out-of-range scores from the real datasets', async () => {
    const priors = await loadQualityPriors(dataDir);
    expect(Object.keys(priors).length).toBeGreaterThan(0);
    for (const [id, value] of Object.entries(priors)) {
      expect(Number.isFinite(value.score), `${id} score`).toBe(true);
      expect(value.score, `${id} score range`).toBeGreaterThanOrEqual(0);
      expect(value.score, `${id} score range`).toBeLessThanOrEqual(1);
      expect(Number.isFinite(value.confidence), `${id} confidence`).toBe(true);
      expect(value.confidence, `${id} confidence range`).toBeGreaterThanOrEqual(0);
      expect(value.confidence, `${id} confidence range`).toBeLessThanOrEqual(1);
    }
  });

  it.fails('never surfaces a NaN or negative ranking score even for a degenerate prior', () => {
    const ranked = rankFreeCodingModels(
      [{ providerId: 'groq', id: 'qwen3.8-27b', name: 'Qwen 3.8 27B' }],
      { 'qwen3.8-27b': prior(Number.NaN, 0.5) },
    );
    // BUG: rankFreeCodingModels passes the prior score straight through, so a
    // non-finite prior yields a NaN displayed score (Math.max(0, NaN) === NaN
    // and Number(NaN.toFixed(4)) === NaN) instead of falling back to baseline.
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ranked[0]?.score)).toBe(true);
  });

  it('clamps a negative prior score up to zero', () => {
    const ranked = rankFreeCodingModels(
      [{ providerId: 'groq', id: 'qwen3.8-27b', name: 'Qwen 3.8 27B' }],
      { 'qwen3.8-27b': prior(-5, 0.5) },
    );
    expect(ranked[0]?.score).toBe(0);
  });

  it('is monotonic in confidence for a penalized preview model', () => {
    const id = 'gemini-3.8-flash-1.5b-preview';
    const low = rankFreeCodingModels([{ providerId: 'gemini', id, name: 'Gemini preview 1.5B' }], {
      [id]: prior(0.4, 0.1),
    })[0];
    const high = rankFreeCodingModels([{ providerId: 'gemini', id, name: 'Gemini preview 1.5B' }], {
      [id]: prior(0.4, 0.8),
    })[0];
    expect(low?.penalty).toBe(0.1);
    expect(high?.penalty).toBe(0);
    expect(high?.score).toBeGreaterThanOrEqual(low?.score ?? Number.NEGATIVE_INFINITY);
  });
});

describe('QA final: quality helpers are total', () => {
  it('returns a finite non-negative penalty for arbitrary model text', () => {
    fc.assert(
      fc.property(fc.string(), fc.double({ min: 0, max: 1, noNaN: true }), (name, confidence) => {
        const penalty = qualityPenaltyForModel(name, confidence);
        return Number.isFinite(penalty) && penalty >= 0 && penalty <= 1;
      }),
      { numRuns: 200, seed: 7 },
    );
  });

  it('recognizes safety-filtered families and leaves normal coders alone', () => {
    expect(isSafetyFilteredModel('gpt-oss-safeguard-20b')).toBe(true);
    expect(isSafetyFilteredModel('qwen3-coder-32b-guard')).toBe(true);
    expect(isSafetyFilteredModel('guard')).toBe(true);
    expect(isSafetyFilteredModel('qwen3.8-27b')).toBe(false);
  });
});
