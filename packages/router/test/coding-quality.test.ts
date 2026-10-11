import { expect, it } from 'vitest';
import {
  sampleModelInfo as sampleModel,
  sampleProvider,
  sampleProfile,
} from '@ferry/shared/testing';
import {
  boundedCodingObservations,
  codingQuality,
  benchCodingObservations,
  runCodingObservations,
  scoreModels,
} from '../src/index.js';
import { RunReportSchema, type CodingObservation } from '@ferry/shared';
const now = Date.now();
const observations: CodingObservation[] = Array.from({ length: 12 }, (_, i) => ({
  modelRef: 'groq/strong',
  score: 1,
  weight: 1,
  at: now,
  source: 'bench',
  sampleId: String(i),
}));
it('bounds and deduplicates evidence, and decays stale success toward neutral', () => {
  expect(boundedCodingObservations([...observations, ...observations], now)).toHaveLength(12);
  expect(codingQuality(observations, 'groq/strong', now).score).toBeGreaterThan(
    codingQuality(observations, 'groq/strong', now + 7 * 86400000).score,
  );
  expect(codingQuality(observations, 'groq/strong', now + 31 * 86400000)).toEqual({
    score: 0.5,
    samples: 0,
  });
});
it('skips dry runs and skipped tasks, and splits confidence across models', () => {
  const report = {
    schemaVersion: 1 as const,
    kind: 'bench' as const,
    generatedAt: new Date(now).toISOString(),
    runs: [
      { task: 'edit', status: 'pass' as const, modelsUsed: ['groq/a', 'groq/b'] },
      { task: 'not-run', status: 'skipped' as const, modelsUsed: ['groq/a'] },
    ],
  };
  expect(benchCodingObservations({ ...report, dryRun: true })).toEqual([]);
  expect(benchCodingObservations(report)).toHaveLength(2);
  expect(benchCodingObservations(report)[0]?.weight).toBe(0.5);
});
it('Auto edit and review prefer coding success over a weak fast responder; planning stays responsive', () => {
  const models = ['strong', 'weak'].map((name) => ({
    ...sampleModel,
    ref: `groq/${name}` as typeof sampleModel.ref,
    providerId: 'groq' as typeof sampleModel.providerId,
    name,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
  }));
  const provider = {
    ...sampleProvider,
    id: 'groq' as typeof sampleProvider.id,
    enabled: true,
    keyStatus: 'valid' as const,
    health: 'ok' as const,
  };
  const input = {
    models,
    providers: [provider],
    profile: {
      ...sampleProfile,
      allowedProviders: 'all_free' as const,
      paidAllowed: false,
      routingObjective: 'balanced' as const,
    },
    capacity: { providers: [provider], models, now: new Date(now).toISOString() },
    estimate: { inputTokens: 1, requiresTools: true },
    codingObservations: [
      ...observations,
      ...observations.map((item) => ({ ...item, modelRef: 'groq/weak', score: 0 })),
    ],
    stats: [
      {
        modelRef: models[0]?.ref ?? sampleModel.ref,
        averageLatencyMs: 6000,
        toolCalls: 1,
        toolCallValidationFailures: 0,
        cacheAffinity: 0,
      },
      {
        modelRef: models[1]?.ref ?? sampleModel.ref,
        averageLatencyMs: 10,
        toolCalls: 1,
        toolCallValidationFailures: 0,
        cacheAffinity: 0,
      },
    ],
  };
  for (const step of ['edit', 'review'] as const)
    expect(scoreModels({ ...input, step })[0]?.ref).toBe('groq/strong');
  expect(scoreModels({ ...input, step: 'plan' })[0]?.ref).toBe('groq/weak');
});
it('uses checklist pass rate and does not penalize user cancellation', () => {
  const report = RunReportSchema.parse({
    durationMs: 1,
    steps: 2,
    ownerModel: 'groq/strong',
    switches: [],
    waits: [],
    failedAttempts: [],
    tokens: { input: 1, output: 1, reasoning: 0 },
    warnings: [],
    outcome: 'completed',
    filesChanged: [],
    modelsUsed: [{ model: 'groq/strong', steps: 2 }],
    checklist: [
      { id: '1', text: 'a', status: 'done' },
      { id: '2', text: 'b', status: 'failed' },
    ],
  });
  expect(runCodingObservations(report, 'run', now)[0]?.score).toBe(0.5);
  expect(runCodingObservations({ ...report, outcome: 'cancelled' }, 'run', now)).toEqual([]);
  expect(runCodingObservations({ ...report, checklist: [] }, 'plain-chat', now)).toEqual([]);
});
