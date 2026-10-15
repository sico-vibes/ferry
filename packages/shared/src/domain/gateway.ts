import { z } from 'zod';

/**
 * One request the local Gateway routed, for the live request log. Metadata only: prompt and
 * response contents are never recorded.
 */
export const GatewayRequestRecordSchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  keyId: z.string(),
  keyName: z.string(),
  /** Model the client asked for, e.g. "ferry/auto-free" or a concrete ref. */
  requestedModel: z.string(),
  /** Upstream model that answered; null when every candidate failed. */
  modelRef: z.string().nullable(),
  servedModel: z.string().nullable().optional(),
  traceId: z.string().optional(),
  attempts: z
    .array(
      z.object({
        model: z.string(),
        status: z.enum(['started', 'failed', 'served', 'skipped']),
        reason: z.string().optional(),
        durationMs: z.number().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
        estimatedCost: z.boolean().optional(),
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        cachedTokens: z.number().int().nonnegative().optional(),
        /** Actual producer/connection/account evidence captured before the attempt resolves. */
        providerId: z.string().nullable().optional(),
        connectionId: z.string().nullable().optional(),
        accountKey: z.string().nullable().optional(),
        bucketId: z.string().nullable().optional(),
        resetAt: z.iso.datetime().nullable().optional(),
        retryAfterMs: z.number().nonnegative().nullable().optional(),
      }),
    )
    .optional(),
  providerId: z.string().nullable(),
  /**
   * Actual upstream producer/connection/account captured before any queue wait. Nonsecret evidence
   * for the history view; the opaque account key never contains credentials.
   */
  servedProviderId: z.string().nullable().optional(),
  servedConnectionId: z.string().nullable().optional(),
  servedAccountKey: z.string().nullable().optional(),
  status: z.enum(['ok', 'error']),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * Authoritative per-dimension usage evidence captured from the producer. A genuinely unreported
   * dimension is `null` (shown as "Not reported"); a reported `0` stays `0`. Backward-compatible:
   * older records omit this object and consumers fall back to the numeric counters above.
   */
  reportedUsage: z
    .object({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      cachedTokens: z.number().int().nonnegative().nullable(),
      reasoningTokens: z.number().int().nonnegative().nullable(),
    })
    .optional(),
  latencyMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
  outcome: z.enum(['completed', 'cancelled', 'failed', 'partial']).optional(),
  firstResponseMs: z.number().nonnegative().nullable().optional(),
  queueWaitMs: z.number().nonnegative().optional(),
  usageReported: z.boolean().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
  estimatedCost: z.boolean().optional(),
  constraints: z.array(z.string()).optional(),
});
export type GatewayRequestRecord = z.infer<typeof GatewayRequestRecordSchema>;

export const GatewayHistoryQuerySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
  query: z.string().max(200).default(''),
  keyId: z.string().optional(),
  status: z.enum(['ok', 'error']).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export type GatewayHistoryQuery = z.input<typeof GatewayHistoryQuerySchema>;
export interface GatewayHistoryPage {
  records: GatewayRequestRecord[];
  total: number;
  nextOffset: number | null;
}
export interface GatewayUsageGroup {
  name: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  actualUsd: number;
  estimatedUsd: number;
  unknownCosts: number;
}
export interface GatewayUsageSummary {
  groups: GatewayUsageGroup[];
  allowanceNote: string;
}
export interface GatewayRoutingExplanation {
  profile: string;
  summary: string;
  eligible: { modelRef: string; providerId: string; order: number; quotaHeadroom: number | null }[];
  excluded: { modelRef: string; reason: string }[];
  lastDecision: GatewayRequestRecord | null;
}
export interface GatewayActivity {
  active: number;
  queued: number;
}
export interface GatewayConnectionTest {
  ok: boolean;
  requestId: string | null;
  model: string | null;
  message: string;
}
