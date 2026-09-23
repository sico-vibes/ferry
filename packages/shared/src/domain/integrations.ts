import { z } from 'zod';
import { McpServerIdSchema, SkillIdSchema } from './ids.js';
export const McpServerSchema = z.object({
  id: McpServerIdSchema,
  name: z.string(),
  brand: z.string().nullable(),
  transport: z.enum(['stdio', 'http']),
  status: z.enum(['connected', 'disconnected', 'error']),
  verified: z.boolean(),
  toolCount: z.number().int().nonnegative(),
});
export type McpServer = z.infer<typeof McpServerSchema>;
export const SkillSchema = z.object({
  id: SkillIdSchema,
  name: z.string(),
  description: z.string(),
  source: z.enum(['bundled', 'user', 'project', 'claude']),
  enabled: z.boolean(),
});
export type Skill = z.infer<typeof SkillSchema>;
