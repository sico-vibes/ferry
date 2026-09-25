import { z } from 'zod';
import { DelegationModeSchema, PermissionModeSchema, ThemeSchema } from './common.js';
import { ProfileIdSchema } from './ids.js';
import { OptimizerTogglesSchema } from './profile.js';
export const SettingsSchema = z.object({
  theme: ThemeSchema,
  homeStyle: z.enum(['auto', 'hero', 'compact']).default('auto'),
  fontScale: z.number().min(0.85).max(1.3),
  restoreTabs: z.boolean(),
  delegationMode: DelegationModeSchema,
  permissionMode: PermissionModeSchema,
  activeProfileId: ProfileIdSchema,
  onboardingComplete: z.boolean(),
  optimizers: OptimizerTogglesSchema,
  developer: z.object({
    showReferenceOverlay: z.boolean(),
    mockLatency: z.boolean(),
    injectErrors: z.boolean(),
    realDomains: z.array(z.string()).default([]),
  }),
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
