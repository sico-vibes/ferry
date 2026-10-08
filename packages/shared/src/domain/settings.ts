import { z } from 'zod';
import { DelegationModeSchema, PermissionModeSchema, ThemeSchema } from './common.js';
import { ProfileIdSchema, ProviderIdSchema } from './ids.js';
import { OptimizerTogglesSchema } from './profile.js';
export const LogicalModelMappingSchema = z.object({
  logicalName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  providerId: ProviderIdSchema,
  upstreamId: z.string().min(1).max(256),
});
export const ProviderRequestOverridesSchema = z.object({
  stripParams: z.array(z.string().min(1).max(128)).default([]),
  forceParams: z.record(z.string(), z.unknown()).default({}),
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string()).default({}),
  statusRemaps: z
    .array(
      z.object({
        from: z.number().int().min(400).max(599),
        to: z.number().int().min(400).max(599),
        messageIncludes: z.string().max(256).optional(),
      }),
    )
    .default([]),
});
export type LogicalModelMapping = z.infer<typeof LogicalModelMappingSchema>;
export type ProviderRequestOverrides = z.infer<typeof ProviderRequestOverridesSchema>;
const RoutingSettingsFieldsSchema = z.object({
  autoPauseAfterFailedRequests: z.number().int().nonnegative(),
  stickySessions: z.boolean(),
  smartReliability: z.boolean(),
  quotaReservations: z.boolean(),
  pinnedExhaustion: z.enum(['handover', 'ask', 'fail']),
  cooldownReasons: z.boolean(),
  gentleQuotaRamp: z.boolean(),
  toolRejectionMemory: z.boolean(),
  carefulModelRetirement: z.boolean(),
  trialOptInProviders: z.array(ProviderIdSchema),
  stickyTtlMinutes: z.number().int().min(1).max(1440),
  rampStart: z.number().min(0.01).max(1),
  rampFloor: z.number().min(0).max(1),
  logicalModelMappings: z.array(LogicalModelMappingSchema),
  providerOverrides: z.record(ProviderIdSchema, ProviderRequestOverridesSchema),
  providerPriorities: z.record(ProviderIdSchema, z.number().int().min(-100).max(100)),
  providerWeights: z.record(ProviderIdSchema, z.number().min(0.01).max(1000)),
});
export const RoutingSettingsSchema = RoutingSettingsFieldsSchema.extend({
  autoPauseAfterFailedRequests: z.number().int().nonnegative().default(5),
  stickySessions: z.boolean().default(true),
  smartReliability: z.boolean().default(true),
  qualityWeight: z.number().min(0).max(20).default(4),
  textToolFallbackEnabled: z.boolean().default(false),
  quotaReservations: z.boolean().default(true),
  pinnedExhaustion: z.enum(['handover', 'ask', 'fail']).default('handover'),
  cooldownReasons: z.boolean().default(true),
  gentleQuotaRamp: z.boolean().default(true),
  toolRejectionMemory: z.boolean().default(true),
  carefulModelRetirement: z.boolean().default(true),
  avoidTrainingProviders: z.boolean().default(false),
  trialOptInProviders: z.array(ProviderIdSchema).default([]),
  stickyTtlMinutes: z.number().int().min(1).max(1440).default(30),
  rampStart: z.number().min(0.01).max(1).default(0.2),
  rampFloor: z.number().min(0).max(1).default(0.1),
  logicalModelMappings: z.array(LogicalModelMappingSchema).default([]),
  providerOverrides: z.record(ProviderIdSchema, ProviderRequestOverridesSchema).default({}),
  providerPriorities: z.record(ProviderIdSchema, z.number().int().min(-100).max(100)).default({}),
  providerWeights: z.record(ProviderIdSchema, z.number().min(0.01).max(1000)).default({}),
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
  storageMode: z.enum(['local', 'cloud']).default('local'),
  cloudOnboardingChoice: z.enum(['local', 'cloud']).nullable().default(null),
  captureContent: z.boolean().optional(),
  theme: ThemeSchema,
  notifications: z.boolean().optional(),
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
/** Resolves content capture using the mode-specific defaults. */
export function resolveCaptureContent(
  settings: Pick<Settings, 'storageMode' | 'captureContent'>,
): boolean {
  return settings.captureContent ?? settings.storageMode === 'cloud';
}
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
  coreBusy: z
    .object({
      busy: z.boolean(),
      eventLoopLagMs: z.number().nonnegative(),
      activeRpcMethod: z.string().nullable(),
    })
    .optional(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;
