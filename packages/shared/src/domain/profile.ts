import { z } from 'zod';
import { DelegationModeSchema, StepKindSchema, TierSchema } from './common.js';
import { ProviderIdSchema, ProfileIdSchema } from './ids.js';
export const FallbackChainEntrySchema = z.object({
  provider: ProviderIdSchema,
  patterns: z.array(z.string().min(1)),
});
export type FallbackChainEntry = z.infer<typeof FallbackChainEntrySchema>;
export const OptimizerTogglesSchema = z.object({
  terse: z.enum(['off', 'lite', 'full', 'ultra']),
  toolOutputFilters: z.boolean(),
  recoveryHandles: z.boolean(),
  contextHygiene: z.boolean(),
  rtk: z.boolean(),
});
export type OptimizerToggles = z.infer<typeof OptimizerTogglesSchema>;
export const ProfileSchema = z.object({
  id: ProfileIdSchema,
  name: z.string(),
  icon: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  pinned: z.boolean(),
  allowedProviders: z.union([z.enum(['all_free', 'all']), z.array(ProviderIdSchema)]),
  tierByStep: z.record(StepKindSchema, z.array(TierSchema)),
  paidAllowed: z.boolean(),
  caps: z.object({
    dailyUsd: z.number().nonnegative().nullable(),
    monthlyUsd: z.number().nonnegative().nullable(),
  }),
  delegationMode: DelegationModeSchema,
  optimizers: OptimizerTogglesSchema,
  fallbackChain: z.array(FallbackChainEntrySchema).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
