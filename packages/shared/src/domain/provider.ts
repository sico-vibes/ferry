import { z } from 'zod';
import { ModelRefSchema, ProviderIdSchema } from './ids.js';
import { PausedReasonSchema } from './failures.js';
import { TierSchema } from './common.js';
import { ProviderErrorKindSchema } from './quota.js';
export const ProviderTagSchema = z.enum([
  'legit',
  'promo',
  'trial',
  'credits',
  'paid',
  'subscription_cli',
  'subscription_oauth',
  'caution',
]);
export type ProviderTag = z.infer<typeof ProviderTagSchema>;
export const ProviderFreePlanSchema = z.object({
  sourceUrl: z.url(),
  models: z.array(z.string().min(1)),
  excludedModels: z.array(z.string().min(1)).optional(),
});
export type ProviderFreePlan = z.infer<typeof ProviderFreePlanSchema>;
export const ProviderKeySchema = z.object({
  id: z.string(),
  providerId: ProviderIdSchema,
  label: z.string(),
  order: z.number().int().nonnegative(),
  enabled: z.boolean(),
  status: z.enum(['ok', 'rate_limited', 'invalid', 'disabled']),
  lastFour: z.string().max(4),
  usageToday: z.object({
    requests: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
  }),
  lastError: z.string().nullable(),
  cooldownUntil: z.iso.datetime().nullable(),
});
export type ProviderKey = z.infer<typeof ProviderKeySchema>;
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
  observedAt: z.iso.datetime().nullable().optional(),
  durationMs: z.number().positive().nullable().optional(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export const ProviderSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  tag: ProviderTagSchema,
  /** False when the provider endpoint is free without a user key. */
  keyRequired: z.boolean().optional(),
  /** Sourced free-tier coverage and any explicitly excluded model patterns. */
  freePlan: ProviderFreePlanSchema.optional(),
  /** User override: this key is billed, even when the provider advertises a free tier. */
  billingEnabled: z.boolean().optional(),
  kind: z.enum(['api', 'cli']),
  brand: z.string().nullable(),
  keyStatus: z.enum(['missing', 'valid', 'invalid', 'unchecked', 'not_applicable']),
  keyCount: z.number().int().nonnegative().optional(),
  autoDisableEnabled: z.boolean().optional(),
  autoDisableFailureCount: z.number().int().min(2).max(20).optional(),
  autoDisableFailureWindowMinutes: z.number().int().min(1).max(1440).optional(),
  autoDisableStatusCodes: z.array(z.number().int().min(100).max(599)).optional(),
  autoDisableKeywords: z.array(z.string().trim().min(1).max(120)).optional(),
  autoDisableMinutes: z.number().int().min(1).max(1440).optional(),
  autoPauseAfterFailedRequests: z.number().int().nonnegative().optional(),
  pausedReason: PausedReasonSchema.nullable().optional(),
  enabled: z.boolean(),
  health: z.enum(['ok', 'cooldown', 'down', 'unknown', 'auth_invalid', 'account_disabled']),
  cooldownUntil: z.iso.datetime().nullable(),
  cooldownProvenance: z
    .enum(['heuristic', 'authoritative', 'credit', 'tier'])
    .nullable()
    .optional(),
  dataUse: z.string().nullable(),
  /** Explicit catalog classification; null means infer from the policy text. */
  dataUseTraining: z.boolean().nullable().optional(),
  termsNote: z.string().nullable(),
  signupUrl: z.string().nullable(),
  docsUrl: z.string().nullable(),
  verifiedAt: z.iso.date().nullable(),
  modelCount: z.number().int().nonnegative(),
  availableModels: z.array(z.lazy(() => ModelInfoSchema)).optional(),
  modelsVerifiedAt: z.iso.datetime().nullable().optional(),
  discoveryFailedAt: z.iso.datetime().nullable().optional(),
  discoveryFailures: z.number().int().nonnegative().optional(),
  discoveryErrorClass: z
    .enum(['auth', 'network', 'server', 'not_found', 'unknown'])
    .nullable()
    .optional(),
  discoveryUnsupported: z.boolean().optional(),
  freeTierUnsupported: z.boolean().optional(),
  excludedModelRefs: z.array(ModelRefSchema).optional(),
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
export const EffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;
export const ModelInfoSchema = z.object({
  failing: z.boolean().optional(),
  verified: z.boolean().optional(),
  verifiedAt: z.iso.datetime().nullable().optional(),
  ref: ModelRefSchema,
  providerId: ProviderIdSchema,
  name: z.string(),
  family: z.string().nullable().optional(),
  tier: TierSchema,
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  toolCalling: z.boolean(),
  reasoning: z.boolean(),
  reasoningEfforts: z.array(EffortSchema).optional(),
  free: z.boolean(),
  priceInPerM: z.number().nonnegative().nullable(),
  priceOutPerM: z.number().nonnegative().nullable(),
  /** Cached prompt-read price per million tokens when published by the catalog. */
  priceCachedInPerM: z.number().nonnegative().nullable().optional(),
  /** Cached prompt multiplier when the catalog has no exact cached-read price. */
  cachedInputRatio: z.number().nonnegative().max(1).optional(),
  capability: z
    .object({
      toolCall: z.boolean().nullable(),
      parallelToolCalls: z.boolean().nullable(),
      vision: z.boolean(),
      reasoning: z.boolean(),
      context: z.number().int().positive(),
      maxOutput: z.number().int().positive(),
      editFormat: z.string(),
      toolProtocol: z.enum(['native', 'xml', 'react', 'none']),
      cachePrompt: z.boolean().nullable(),
      temperature: z.boolean().nullable(),
    })
    .optional(),
  quality: z.number().min(0).max(1).nullable().optional(),
  qualityConfidence: z.number().min(0).max(1).optional(),
  qualityPenalty: z.number().min(0).max(1).optional(),
  qualitySources: z.array(z.string()).optional(),
  qualityDate: z.iso.date().nullable().optional(),
  /** Catalog facts (models.dev), shown in the model picker only when present. */
  description: z.string().optional(),
  releaseDate: z.string().optional(),
  knowledgeCutoff: z.string().optional(),
  openWeights: z.boolean().optional(),
  inputModalities: z.array(z.string()).optional(),
  gateway: z.object({ keyId: z.string(), keyName: z.string(), modelName: z.string() }).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export const ProviderHealthSnapshotSchema = z.object({
  providerId: ProviderIdSchema,
  state: z.enum(['healthy', 'degraded', 'down']),
  breaker: z.enum(['closed', 'open', 'half_open']),
  openedAt: z.iso.datetime().nullable(),
  nextProbeAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  keys: z.array(
    z.object({
      keyId: z.string(),
      cooldownUntil: z.iso.datetime().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  lockedModels: z.array(
    z.object({ ref: ModelRefSchema, until: z.iso.datetime(), reason: z.string() }),
  ),
  latencyP50Ms: z.number().nonnegative().nullable(),
  latencyP95Ms: z.number().nonnegative().nullable(),
  successRate1h: z.number().min(0).max(1).nullable(),
});
export type ProviderHealthSnapshot = z.infer<typeof ProviderHealthSnapshotSchema>;
export const ModelCandidateSchema = z.object({
  ref: ModelRefSchema,
  score: z.number(),
  stepsLeft: z.number().nonnegative().nullable(),
  explanation: z.string(),
  scoreBreakdown: z
    .object({
      tierFit: z.number(),
      headroom: z.number(),
      success: z.number(),
      latency: z.number(),
      cost: z.number(),
      affinity: z.number(),
      coding: z.number(),
      quality: z.number(),
      preference: z.number(),
      reasoning: z.number(),
      verification: z.number(),
      quotaHeadroomFactor: z.number().min(0).max(1).optional(),
    })
    .optional(),
  selected: z.boolean(),
});
export type ModelCandidate = z.infer<typeof ModelCandidateSchema>;
