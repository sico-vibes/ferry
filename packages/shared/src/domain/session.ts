import { z } from 'zod';
import {
  CheckpointIdSchema,
  ModelRefSchema,
  PartIdSchema,
  ProfileIdSchema,
  RunIdSchema,
  SessionIdSchema,
  MessageIdSchema,
  WorkspaceIdSchema,
} from './ids.js';
export const SessionStatusSchema = z.enum(['idle', 'running', 'awaiting_approval', 'error']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export const SessionSchema = z.object({
  id: SessionIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: z.string(),
  preview: z.string(),
  profileId: ProfileIdSchema,
  modelRef: ModelRefSchema.nullable(),
  starred: z.boolean(),
  pinned: z.boolean(),
  status: SessionStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Session = z.infer<typeof SessionSchema>;
export const FileChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;
// Tool sources are extensible (MCP servers and skills register tools at runtime),
// so persisted calls must accept any non-empty registered tool name.
export const ToolNameSchema = z.string().min(1);
export type ToolName = z.infer<typeof ToolNameSchema>;
export const ToolOutputSchema = z.object({
  text: z.string(),
  filtered: z.boolean(),
  originalTokens: z.number().int().nonnegative().nullable(),
  filteredTokens: z.number().int().nonnegative().nullable(),
  recoveryHandle: z.string().nullable(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
const partBase = { id: PartIdSchema };
export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), ...partBase, text: z.string() }),
  z.object({ type: z.literal('reasoning'), ...partBase, text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    ...partBase,
    tool: ToolNameSchema,
    title: z.string(),
    args: z.record(z.string(), z.unknown()),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'denied']),
    output: ToolOutputSchema.nullable(),
    changes: z.array(FileChangeSchema),
    durationMs: z.number().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal('approval_request'),
    ...partBase,
    kind: z.enum(['command', 'edit', 'delegation', 'paid_model']),
    summary: z.string(),
    detail: z.string(),
    risk: z.enum(['low', 'medium', 'high']),
    state: z.enum(['pending', 'allowed_once', 'allowed_always', 'denied']),
  }),
  z.object({
    type: z.literal('handoff_marker'),
    ...partBase,
    from: ModelRefSchema,
    to: ModelRefSchema,
    reason: z.enum(['quota', 'rate_limit', 'error', 'context', 'capability', 'manual']),
    briefingTokens: z.number().int().nonnegative(),
    explanation: z.string(),
  }),
  z.object({ type: z.literal('delegation'), ...partBase, runId: RunIdSchema }),
  z.object({
    type: z.literal('checkpoint'),
    ...partBase,
    checkpointId: CheckpointIdSchema,
    label: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    ...partBase,
    message: z.string(),
    kind: z.enum(['provider', 'tool', 'permission', 'internal']),
  }),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;
export const MessageSchema = z.object({
  id: MessageIdSchema,
  sessionId: SessionIdSchema,
  role: z.enum(['user', 'assistant']),
  createdAt: z.iso.datetime(),
  modelRef: ModelRefSchema.nullable(),
  parts: z.array(MessagePartSchema),
});
export type Message = z.infer<typeof MessageSchema>;
export const PlanItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['todo', 'doing', 'done', 'blocked']),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;
export const TaskRecordSchema = z.object({
  sessionId: SessionIdSchema,
  goal: z.string(),
  plan: z.array(PlanItemSchema),
  decisions: z.array(z.object({ text: z.string(), why: z.string(), at: z.iso.datetime() })),
  touchedFiles: z.array(z.object({ path: z.string(), purpose: z.string() })),
  nextStep: z.string().nullable(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export const SessionDetailSchema = z.object({
  session: SessionSchema,
  messages: z.array(MessageSchema),
  taskRecord: TaskRecordSchema,
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export const CheckpointSchema = z.object({
  id: CheckpointIdSchema,
  sessionId: SessionIdSchema,
  label: z.string(),
  createdAt: z.iso.datetime(),
  fileCount: z.number().int().nonnegative(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
