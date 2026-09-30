import { z } from 'zod';
import { DelegationModeSchema, PermissionModeSchema, ThemeSchema } from './common.js';
import { ProfileIdSchema, ProviderIdSchema } from './ids.js';
import { OptimizerTogglesSchema } from './profile.js';
const RoutingSettingsFieldsSchema = z.object({
  stickySessions: z.boolean(),
  smartReliability: z.boolean(),
  quotaReservations: z.boolean(),
  cooldownReasons: z.boolean(),
  gentleQuotaRamp: z.boolean(),
  toolRejectionMemory: z.boolean(),
  carefulModelRetirement: z.boolean(),
  trialOptInProviders: z.array(ProviderIdSchema),
  stickyTtlMinutes: z.number().int().min(1).max(1440),
  rampStart: z.number().min(0.01).max(1),
  rampFloor: z.number().min(0).max(1),
});
export const RoutingSettingsSchema = RoutingSettingsFieldsSchema.extend({
  stickySessions: z.boolean().default(true),
  smartReliability: z.boolean().default(true),
  qualityWeight: z.number().min(0).max(20).default(4),
  textToolFallbackEnabled: z.boolean().default(false),
  quotaReservations: z.boolean().default(true),
  cooldownReasons: z.boolean().default(true),
  gentleQuotaRamp: z.boolean().default(true),
  toolRejectionMemory: z.boolean().default(true),
  carefulModelRetirement: z.boolean().default(true),
  avoidTrainingProviders: z.boolean().default(false),
  trialOptInProviders: z.array(ProviderIdSchema).default([]),
  stickyTtlMinutes: z.number().int().min(1).max(1440).default(30),
  rampStart: z.number().min(0.01).max(1).default(0.2),
  rampFloor: z.number().min(0).max(1).default(0.1),
});
export const DEFAULT_ROUTING_SETTINGS = RoutingSettingsSchema.parse({});
export type RoutingSettings = z.infer<typeof RoutingSettingsSchema>;
export const PaidCapsSchema = z.object({
  sessionUsd: z.number().nonnegative().nullable().default(null),
  dailyUsd: z.number().nonnegative().nullable().default(null),
  monthlyUsd: z.number().nonnegative().nullable().default(null),
});
export type PaidCaps = z.infer<typeof PaidCapsSchema>;
export const SettingsSchema = z.object({
  theme: ThemeSchema,
  homeStyle: z.enum(['auto', 'hero', 'compact']).default('auto'),
  fontScale: z.number().min(0.85).max(1.3),
  restoreTabs: z.boolean(),
  allowSubscriptionOAuthRouting: z.boolean().default(false),
  toolCallRepair: z.boolean().default(true),
  subscriptionOAuthAcknowledged: z.array(z.string()).default([]),
  delegationMode: DelegationModeSchema,
  permissionMode: PermissionModeSchema,
  activeProfileId: ProfileIdSchema,
  paidCaps: PaidCapsSchema.default({ sessionUsd: null, dailyUsd: null, monthlyUsd: null }),
  onboardingComplete: z.boolean(),
  optimizers: OptimizerTogglesSchema,
  routing: RoutingSettingsSchema.default(DEFAULT_ROUTING_SETTINGS),
  developer: z.object({
    showReferenceOverlay: z.boolean(),
    mockLatency: z.boolean(),
    injectErrors: z.boolean(),
    realDomains: z.array(z.string()).default([]),
  }),
});
export const SettingsPatchSchema = SettingsSchema.partial().extend({
  paidCaps: PaidCapsSchema.partial().optional(),
  optimizers: OptimizerTogglesSchema.partial().optional(),
  routing: RoutingSettingsFieldsSchema.partial().optional(),
  developer: z
    .object({
      showReferenceOverlay: z.boolean(),
      mockLatency: z.boolean(),
      injectErrors: z.boolean(),
      realDomains: z.array(z.string()),
    })
    .partial()
    .optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SystemInfoSchema = z.object({
  version: z.string(),
  mock: z.boolean(),
  platform: z.enum(['win32', 'darwin', 'linux', 'web']),
  dataDir: z.string().nullable(),
  realDomains: z.array(z.string()),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;
