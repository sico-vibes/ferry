import { z } from 'zod';
import { ProviderIdSchema } from './ids.js';

export const ProviderErrorKindSchema = z.enum([
  'auth',
  'forbidden',
  'not_found',
  'gone',
  'rate_limit',
  'quota_exhausted',
  'context_overflow',
  'bad_request',
  'server',
  'network',
  'timeout',
  'unsupported_free_tier',
]);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKindSchema>;

// Canonical telemetry keeps the provider's model reference, numeric HTTP status,
// request size, and allowlisted rate-limit headers at the shared boundary.
export const RawCallObservationSchema = z.object({
  providerId: ProviderIdSchema,
  modelRef: z.string().min(1),
  startedAt: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  statusCode: z.number().int().nullable(),
  requestBytes: z.number().int().nonnegative().nullable(),
  rateLimitHeaders: z.record(z.string(), z.string()),
  errorKind: ProviderErrorKindSchema.nullable(),
});
export type RawCallObservation = z.infer<typeof RawCallObservationSchema>;

// Usage is normalized from call telemetry: modelRef and occurredAt replace the
// adapter-only model and status fields; richer session, task, cost, and plan data
// remain available for the quota engine.
export const UsageRecordSchema = z.object({
  id: z.string().min(1),
  providerId: ProviderIdSchema,
  modelRef: z.string().min(1),
  occurredAt: z.iso.datetime(),
  sessionId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  stepKind: z.string().nullable().optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cachedTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  planUnits: z.number().nonnegative().optional(),
  status: z.string().default('success'),
  errorKind: ProviderErrorKindSchema.nullable().optional(),
  latencyMs: z.number().nonnegative().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const QuotaObservationSchema = z.object({
  id: z.string().min(1),
  providerId: ProviderIdSchema,
  modelRef: z.string().nullable().optional(),
  windowId: z.string(),
  metric: z.enum(['requests', 'tokens', 'usd', 'credits']),
  value: z.number().nonnegative().optional(),
  limit: z.number().nonnegative().nullable().optional(),
  remaining: z.number().nonnegative().nullable().optional(),
  resetAt: z.iso.datetime().nullable().optional(),
  source: z.enum(['endpoint', 'header', 'learned', 'catalog']),
  surprise: z.boolean().optional(),
  observedAt: z.iso.datetime(),
  statusCode: z.number().int().optional(),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;

export const ProviderHealthSchema = z.enum([
  'ok',
  'cooldown',
  'down',
  'unknown',
  'auth_invalid',
  'account_disabled',
]);
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const CapacitySummarySchema = z.object({
  stepsLeftToday: z.number().nonnegative(),
  percentRemaining: z.number().min(0).max(100),
  lowCapacity: z.boolean(),
  perProvider: z.array(
    z.object({
      providerId: ProviderIdSchema,
      stepsLeft: z.number().nonnegative().nullable(),
      percent: z.number().min(0).max(100).nullable(),
      nextResetAt: z.iso.datetime().nullable(),
    }),
  ),
  nextResets: z.array(
    z.object({
      providerId: ProviderIdSchema,
      windowId: z.string(),
      label: z.string(),
      at: z.iso.datetime(),
    }),
  ),
  banner: z
    .object({
      text: z.string(),
      actionLabel: z.string(),
      action: z.enum(['add_provider', 'open_usage', 'switch_profile']),
    })
    .nullable(),
  updatedAt: z.iso.datetime(),
});
export type CapacitySummary = z.infer<typeof CapacitySummarySchema>;
export const UsageHistoryPointSchema = z.object({
  date: z.iso.date(),
  providerId: ProviderIdSchema,
  requests: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type UsageHistoryPoint = z.infer<typeof UsageHistoryPointSchema>;
export const HandoffReasonSchema = z.enum([
  'quota',
  'rate_limit',
  'error',
  'context',
  'capability',
  'manual',
]);
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;
export const HandoffStatSchema = z.object({
  reason: HandoffReasonSchema,
  count: z.number().int().nonnegative(),
});
export type HandoffStat = z.infer<typeof HandoffStatSchema>;
