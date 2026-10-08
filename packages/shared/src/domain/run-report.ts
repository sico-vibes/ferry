import { z } from 'zod';
import { ModelRefSchema, SessionIdSchema } from './ids.js';
import { ProviderFailureFamilySchema } from './quota.js';

export const RunReportSchema = z.object({
  durationMs: z.number().nonnegative(),
  steps: z.number().int().nonnegative(),
  ownerModel: ModelRefSchema.nullable(),
  modelsUsed: z.array(z.object({ model: ModelRefSchema, steps: z.number().int().nonnegative() })),
  switches: z.array(
    z.object({
      from: ModelRefSchema,
      to: ModelRefSchema,
      reason: z.string(),
      atStep: z.number().int().positive(),
    }),
  ),
  waits: z.array(
    z.object({ provider: z.string(), seconds: z.number().nonnegative(), reason: z.string() }),
  ),
  failedAttempts: z.array(
    z.object({ kind: ProviderFailureFamilySchema, count: z.number().int().positive() }),
  ),
  tokens: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
  }),
  filesChanged: z.array(
    z.object({
      path: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      status: z.enum(['added', 'modified', 'deleted']),
    }),
  ),
  outcome: z.enum([
    'completed',
    'completed_with_warnings',
    'error',
    'cancelled',
    'paused',
    'limit',
  ]),
  warnings: z.array(z.string()),
});
export type RunReport = z.infer<typeof RunReportSchema>;
export const RunCompletedSchema = z.object({
  sessionId: SessionIdSchema,
  outcome: RunReportSchema.shape.outcome,
  warnings: z.array(z.string()),
  report: RunReportSchema,
});
export type RunCompleted = z.infer<typeof RunCompletedSchema>;

/** Shared plain-text report for the CLI and the desktop activity disclosure. */
export function formatRunReport(report: RunReport): string[] {
  return [
    `Run ${report.outcome.replaceAll('_', ' ')} in ${String(Math.round(report.durationMs / 1000))}s; ${String(report.steps)} steps`,
    `Owner: ${report.ownerModel ?? 'none'}`,
    `Models: ${report.modelsUsed.map((entry) => `${entry.model} (${String(entry.steps)} steps)`).join(', ') || 'none'}`,
    `Switches: ${report.switches.map((entry) => `${entry.from} → ${entry.to} (${entry.reason}, step ${String(entry.atStep)})`).join('; ') || 'none'}`,
    `Waits: ${report.waits.map((entry) => `${entry.provider} ${String(Math.ceil(entry.seconds))}s (${entry.reason})`).join('; ') || 'none'}`,
    `Failed attempts: ${report.failedAttempts.map((entry) => `${entry.kind} ${String(entry.count)}`).join(', ') || 'none'}`,
    `Tokens: ${String(report.tokens.input)} in, ${String(report.tokens.output)} out, ${String(report.tokens.reasoning)} reasoning`,
    `Files: ${report.filesChanged.map((entry) => `${entry.path} (${String(entry.sizeBytes)} bytes, ${entry.status})`).join(', ') || 'none'}`,
    ...report.warnings.map((warning) => `Warning: ${warning}`),
  ];
}
