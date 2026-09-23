import { z } from 'zod';
import { DelegationModeSchema, PermissionModeSchema, ThemeSchema } from './common.js';
import { ProfileIdSchema } from './ids.js';
import { OptimizerTogglesSchema } from './profile.js';
export const SettingsSchema = z.object({
  theme: ThemeSchema,
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
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SystemInfoSchema = z.object({
  version: z.string(),
  mock: z.boolean(),
  platform: z.enum(['win32', 'darwin', 'linux', 'web']),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;
