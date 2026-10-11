import { z } from 'zod';
export const ProviderCheckResultSchema = z.object({
  providerId: z.string(),
  modelRef: z.string(),
  ok: z.boolean(),
  at: z.iso.datetime(),
  firstResponseMs: z.number().nonnegative().nullable(),
  completionMs: z.number().nonnegative().nullable(),
  sampleCount: z.literal(1),
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
