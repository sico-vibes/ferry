import { z } from 'zod';
export const ProviderCheckResultSchema = z.object({
  reachability: z.enum(['reachable', 'unreachable', 'unknown']).optional(),
  authentication: z.enum(['accepted', 'rejected', 'unknown', 'not_required']).optional(),
  paid: z.boolean().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
  estimatedCost: z.boolean().optional(),
  providerId: z.string(),
  modelRef: z.string(),
  ok: z.boolean(),
  at: z.iso.datetime(),
  firstResponseMs: z.number().nonnegative().nullable(),
  completionMs: z.number().nonnegative().nullable(),
  sampleCount: z.number().int().min(0).max(1),
  message: z.string(),
  features: z.literal(
    'Text generation tested; tools, structured output and multimodal compatibility require request-specific verification.',
  ),
});
export type ProviderCheckResult = z.infer<typeof ProviderCheckResultSchema>;
export const ProviderCheckProgressSchema = z.object({
  id: z.string(),
  running: z.boolean(),
  cancelled: z.boolean(),
  results: z.array(ProviderCheckResultSchema),
  error: z.string().nullable(),
});
export type ProviderCheckProgress = z.infer<typeof ProviderCheckProgressSchema>;
export const ProviderCheckOptionsSchema = z
  .object({
    /** Approval for this synthetic operation only; never changes inference policy. */
    approvedCostUsd: z.number().positive().max(1).optional(),
  })
  .strict();
export type ProviderCheckOptions = z.infer<typeof ProviderCheckOptionsSchema>;
