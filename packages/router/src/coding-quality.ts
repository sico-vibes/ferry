import type { BenchCodingReport, CodingObservation, RunReport } from '@ferry/shared';
const month = 30 * 86_400_000;
export function boundedCodingObservations(
  entries: readonly CodingObservation[],
  now: number,
): CodingObservation[] {
  return [
    ...new Map(
      entries
        .filter((entry) => entry.at <= now && now - entry.at <= month)
        .map((entry) => [`${entry.source}:${entry.sampleId}:${entry.modelRef}`, entry]),
    ).values(),
  ].slice(-5000);
}
export function codingQuality(
  entries: readonly CodingObservation[],
  modelRef: string,
  now: number,
): { score: number; samples: number } {
  let weight = 0,
    success = 0,
    samples = 0;
  for (const entry of entries) {
    const age = now - entry.at;
    if (entry.modelRef !== modelRef || age < 0 || age > month) continue;
    const value = entry.weight * 0.5 ** (age / (7 * 86_400_000));
    weight += value;
    success += value * entry.score;
    samples++;
  }
  return { score: (success + 1) / (weight + 2), samples };
}
export function benchCodingObservations(report: BenchCodingReport): CodingObservation[] {
  if (report.dryRun) return [];
  return report.runs.flatMap((run, index) => {
    const models = [...new Set(run.modelsUsed ?? [])].filter((model) => model.includes('/'));
    return run.status === 'skipped'
      ? []
      : models.map((modelRef) => ({
          modelRef,
          score: run.status === 'pass' ? 1 : 0,
          weight: 1 / Math.max(1, models.length),
          at: Date.parse(report.generatedAt),
          source: 'bench' as const,
          sampleId: `${report.generatedAt}:${run.task}:${String(run.repeat ?? index)}`,
        }));
  });
}
export function runCodingObservations(
  report: RunReport,
  sampleId: string,
  at: number,
): CodingObservation[] {
  if (['cancelled', 'paused', 'limit'].includes(report.outcome)) return [];
  if (!report.filesChanged.length && !report.checklist?.length) return [];
  const done = (report.checklist ?? []).filter((item) => item.status === 'done').length;
  const checklist = report.checklist?.length ? done / report.checklist.length : 1;
  const score =
    (report.outcome === 'completed' ? 1 : report.outcome === 'completed_with_warnings' ? 0.8 : 0) *
    checklist;
  const models = report.modelsUsed.filter((model) => model.steps > 0);
  return models.map((model) => ({
    modelRef: model.model,
    score,
    weight: 1 / Math.max(1, models.length),
    at,
    source: 'agent',
    sampleId,
  }));
}
