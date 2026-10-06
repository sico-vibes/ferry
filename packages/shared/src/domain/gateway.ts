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
        status: z.enum(['started', 'failed', 'served']),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  providerId: z.string().nullable(),
  status: z.enum(['ok', 'error']),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type GatewayRequestRecord = z.infer<typeof GatewayRequestRecordSchema>;
