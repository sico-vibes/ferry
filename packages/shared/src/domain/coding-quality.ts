import { z } from 'zod';
export const CodingObservationSchema = z.object({
  modelRef: z.string().min(1).max(256),
  score: z.number().min(0).max(1),
  weight: z.number().positive().max(1),
  at: z.number().nonnegative(),
  source: z.enum(['bench', 'agent']),
  sampleId: z.string().max(512),
});
export type CodingObservation = z.infer<typeof CodingObservationSchema>;
export const BenchCodingReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('bench'),
  generatedAt: z.iso.datetime(),
  dryRun: z.boolean().optional(),
  runs: z
    .array(
      z.object({
        task: z.string(),
        repeat: z.number().int().optional(),
        status: z.enum(['pass', 'fail', 'skipped']),
        modelsUsed: z.array(z.string()).optional(),
      }),
    )
    .max(10000),
});
export type BenchCodingReport = z.infer<typeof BenchCodingReportSchema>;
