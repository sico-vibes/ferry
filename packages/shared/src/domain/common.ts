import { z } from 'zod';
export const PermissionModeSchema = z.enum(['ask', 'auto_edit', 'full_auto']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const DelegationModeSchema = z.enum(['off', 'suggest', 'auto']);
export type DelegationMode = z.infer<typeof DelegationModeSchema>;
export const StepKindSchema = z.enum([
  'plan',
  'edit',
  'search',
  'summarize',
  'review',
  'long_context',
]);
export type StepKind = z.infer<typeof StepKindSchema>;
export const TierSchema = z.enum(['T1', 'T2', 'T3']);
export type Tier = z.infer<typeof TierSchema>;
export const ThemeSchema = z.enum(['dark', 'light', 'system']);
export type Theme = z.infer<typeof ThemeSchema>;
