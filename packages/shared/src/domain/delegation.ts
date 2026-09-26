import { z } from 'zod';
import { RunIdSchema, SessionIdSchema } from './ids.js';
import { FileChangeSchema } from './session.js';
export const LaneSchema = z.object({
  name: z.string(),
  implementer: z.enum(['codex', 'opencode', 'claude', 'acp', 'ferry']),
  agent: z.string().nullable().optional(),
  transport: z.enum(['native', 'acp']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  profile: z.string().nullable().default(null),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  variant: z.string().nullable(),
  permission: z.enum(['read_only', 'scoped_write']).nullable().default(null),
  paths: z.array(z.string()).default([]),
  source: z.enum(['global', 'project', 'ferry']),
  trusted: z.boolean(),
});
export type Lane = z.infer<typeof LaneSchema>;
export const AcpAgentDetectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  detectArgs: z.array(z.string()),
  installHint: z.string(),
  supportsModel: z.boolean(),
  supportsMode: z.boolean(),
  launchVerified: z.boolean(),
  verified: z.boolean(),
  verifiedAt: z.iso.date().nullable(),
  caution: z.boolean(),
  cautionNote: z.string().nullable(),
  available: z.boolean(),
  version: z.string().nullable(),
  executable: z.string().nullable(),
  error: z.string().optional(),
});
export type AcpAgentDetection = z.infer<typeof AcpAgentDetectionSchema>;
export const GateResultSchema = z.object({
  command: z.string(),
  ok: z.boolean(),
  outputTail: z.string(),
});
export type GateResult = z.infer<typeof GateResultSchema>;
export const DelegationRunSchema = z.object({
  id: RunIdSchema,
  sessionId: SessionIdSchema,
  lane: z.string(),
  implementer: LaneSchema.shape.implementer,
  brief: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  progress: z.array(z.object({ at: z.iso.datetime(), text: z.string() })),
  finalMessage: z.string().nullable(),
  touchedFiles: z.array(FileChangeSchema),
  gateResults: z.array(GateResultSchema),
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative().nullable(),
      provider: z.literal('subscription_cli').default('subscription_cli'),
    })
    .nullable(),
  decision: z.enum(['accepted', 'rejected', 'rework']).nullable(),
});
export type DelegationRun = z.infer<typeof DelegationRunSchema>;
