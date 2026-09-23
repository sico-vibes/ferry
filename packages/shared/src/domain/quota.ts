import { z } from 'zod';
import { ProviderIdSchema } from './ids.js';
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
