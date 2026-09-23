import { z } from 'zod';
import { PermissionModeSchema } from './common.js';
import { ProfileIdSchema, WorkspaceIdSchema } from './ids.js';
export const WorkspaceSettingsSchema = z.object({
  gateCommands: z.array(z.string()),
  instructionsFile: z.string().nullable(),
  defaultProfileId: ProfileIdSchema.nullable(),
  permissionMode: PermissionModeSchema,
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  name: z.string(),
  path: z.string(),
  gitBranch: z.string().nullable(),
  language: z.enum(['ts', 'js', 'py', 'go', 'rust', 'other']),
  lastOpenedAt: z.iso.datetime(),
  settings: WorkspaceSettingsSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
