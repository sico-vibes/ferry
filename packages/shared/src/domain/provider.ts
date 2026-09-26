import { z } from 'zod';
import { ModelRefSchema, ProviderIdSchema } from './ids.js';
import { TierSchema } from './common.js';
import { ProviderErrorKindSchema } from './quota.js';
export const ProviderTagSchema = z.enum([
  'legit',
  'promo',
  'credits',
  'paid',
  'subscription_cli',
  'subscription_oauth',
  'caution',
]);
export type ProviderTag = z.infer<typeof ProviderTagSchema>;
export const QuotaWindowSchema = z.object({
  id: z.string(),
  scope: z.enum(['provider', 'model']),
  modelRef: ModelRefSchema.nullable(),
  metric: z.enum(['requests', 'tokens', 'usd', 'credits']),
  kind: z.enum(['rolling', 'fixed_daily', 'weekly', 'monthly', 'dynamic']),
  periodLabel: z.string(),
  used: z.number().nonnegative(),
  limit: z.number().nonnegative().nullable(),
  remaining: z.number().nonnegative().nullable(),
  resetAt: z.iso.datetime().nullable(),
  confidence: z.enum(['exact', 'estimated', 'learned', 'unknown']),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export const ProviderSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  tag: ProviderTagSchema,
  kind: z.enum(['api', 'cli']),
  brand: z.string().nullable(),
  keyStatus: z.enum(['missing', 'valid', 'invalid', 'unchecked', 'not_applicable']),
  enabled: z.boolean(),
  health: z.enum(['ok', 'cooldown', 'down', 'unknown', 'auth_invalid', 'account_disabled']),
  cooldownUntil: z.iso.datetime().nullable(),
  dataUse: z.string().nullable(),
  termsNote: z.string().nullable(),
  signupUrl: z.string().nullable(),
  docsUrl: z.string().nullable(),
  verifiedAt: z.iso.date().nullable(),
  modelCount: z.number().int().nonnegative(),
  availableModels: z.array(z.lazy(() => ModelInfoSchema)).optional(),
  modelsVerifiedAt: z.iso.datetime().nullable().optional(),
  windows: z.array(QuotaWindowSchema),
  stepsLeftToday: z.number().nonnegative().nullable(),
});
export type Provider = z.infer<typeof ProviderSchema>;
export const ProbeResultSchema = z.object({
  ok: z.boolean(),
  keyValid: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  message: z.string(),
  windows: z.array(QuotaWindowSchema),
  models: z.array(z.string()),
  errorKind: ProviderErrorKindSchema.nullable(),
  usedModel: z.string().nullable().optional(),
  skippedModels: z.array(z.object({ model: z.string(), reason: z.string() })).optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
export const ModelInfoSchema = z.object({
  ref: ModelRefSchema,
  providerId: ProviderIdSchema,
  name: z.string(),
  tier: TierSchema,
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  toolCalling: z.boolean(),
  reasoning: z.boolean(),
  free: z.boolean(),
  priceInPerM: z.number().nonnegative().nullable(),
  priceOutPerM: z.number().nonnegative().nullable(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export const ModelCandidateSchema = z.object({
  ref: ModelRefSchema,
  score: z.number(),
  stepsLeft: z.number().nonnegative().nullable(),
  explanation: z.string(),
  selected: z.boolean(),
});
export type ModelCandidate = z.infer<typeof ModelCandidateSchema>;
