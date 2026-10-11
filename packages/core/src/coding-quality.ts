import { CodingObservationSchema, BenchCodingReportSchema, type RunReport } from '@ferry/shared';
import {
  boundedCodingObservations,
  benchCodingObservations,
  runCodingObservations,
} from '@ferry/router';
import type { FerryServices } from './services.js';
export function codingObservations(services: FerryServices) {
  return boundedCodingObservations(
    CodingObservationSchema.array().safeParse(services.settings.get('coding-quality')).data ?? [],
    services.clock.now().getTime(),
  );
}
export function importBenchCoding(services: FerryServices, value: unknown) {
  const observations = benchCodingObservations(BenchCodingReportSchema.parse(value));
  const entries = boundedCodingObservations(
    [...codingObservations(services), ...observations],
    services.clock.now().getTime(),
  );
  services.settings.put('coding-quality', entries);
  return { imported: observations.length, total: entries.length };
}
export function recordCodingOutcome(services: FerryServices, report: RunReport, sampleId: string) {
  const now = services.clock.now().getTime();
  services.settings.put(
    'coding-quality',
    boundedCodingObservations(
      [...codingObservations(services), ...runCodingObservations(report, sampleId, now)],
      now,
    ),
  );
}
