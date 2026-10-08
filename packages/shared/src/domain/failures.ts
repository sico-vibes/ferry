import { z } from 'zod';
import { redactForTelemetry } from '../telemetry.js';
import { ModelRefSchema, ProviderIdSchema } from './ids.js';

export const FailureKindSchema = z.enum([
  'auth',
  'server',
  'timeout',
  'no_response',
  'network',
  'model_not_found',
  'bad_request',
  'tools_unsupported',
  'context_too_large',
  'rate_limit',
  'quota_exhausted',
  'local_reservation',
  'cancelled',
]);
export type FailureKind = z.infer<typeof FailureKindSchema>;
export const COUNTED_FAILURE_KINDS: readonly FailureKind[] = [
  'auth',
  'server',
  'timeout',
  'no_response',
  'network',
  'model_not_found',
  'bad_request',
];
export const PausedReasonSchema = z.object({
  kind: z.literal('failed_requests'),
  at: z.iso.datetime(),
  failedRequests: z.number().int().nonnegative(),
  lastError: z.string().max(500),
  lastKind: FailureKindSchema,
  models: z.array(ModelRefSchema),
});
export type PausedReason = z.infer<typeof PausedReasonSchema>;
export const FailureEntrySchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  providerId: ProviderIdSchema,
  modelRef: ModelRefSchema,
  keyId: z.string().nullable(),
  requestId: z.string(),
  sessionId: z.string().nullable(),
  source: z.enum(['agent', 'gateway', 'probe']),
  kind: FailureKindSchema,
  statusCode: z.number().int().nullable(),
  message: z.string().max(500),
  counted: z.union([z.literal(0), z.literal(1)]),
});
export type FailureEntry = z.infer<typeof FailureEntrySchema>;
export const FailureOptionsSchema = z.object({
  sinceHours: z.number().positive().max(720).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type FailureOptions = z.infer<typeof FailureOptionsSchema>;
const counts = {
  failed24h: z.number().int().nonnegative(),
  failed7d: z.number().int().nonnegative(),
  byKind: z.partialRecord(FailureKindSchema, z.number().int().nonnegative()),
  lastError: z.string().max(500).nullable().optional(),
  lastFailureAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
};
export const ProviderFailuresSchema = z.object({
  providers: z.array(
    z.object({
      providerId: ProviderIdSchema,
      ...counts,
      counted24h: z.number().int().nonnegative(),
      consecutive: z.number().int().nonnegative(),
      paused: PausedReasonSchema.nullable(),
      models: z.array(z.object({ modelRef: ModelRefSchema, ...counts, failing: z.boolean() })),
    }),
  ),
  recent: z.array(FailureEntrySchema),
});
export type ProviderFailures = z.infer<typeof ProviderFailuresSchema>;

export function redactFailureMessage(message: string): string {
  return String(redactForTelemetry(message, { maxStringLength: Number.POSITIVE_INFINITY })).slice(
    0,
    500,
  );
}
