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
import { ProviderFailureFamilySchema } from './quota.js';
import { AgentEventSchema } from './agent-event.js';
export const SessionStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_approval',
  'error',
  'interrupted',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export const SessionSchema = z.object({
  id: SessionIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: z.string(),
  preview: z.string(),
  profileId: ProfileIdSchema,
  modelRef: ModelRefSchema.nullable(),
  pinnedModelRef: ModelRefSchema.nullable().default(null),
  starred: z.boolean(),
  pinned: z.boolean(),
  status: SessionStatusSchema,
  // Independent of status so startup can recover a run even if an error handler
  // persisted a terminal status immediately before the process died.
  inFlight: z.boolean().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  agentEvents: z.array(AgentEventSchema).default([]),
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
  z.object({
    type: z.literal('reasoning'),
    ...partBase,
    text: z.string(),
    producedBy: ModelRefSchema.optional(),
    providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    ...partBase,
    tool: ToolNameSchema,
    toolCallId: z.string().optional(),
    producedBy: ModelRefSchema.optional(),
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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
    kind: z.enum(['command', 'edit', 'delegation', 'paid_model', 'model_handover']),
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
    trigger: z.enum(['reactive', 'proactive', 'manual']).optional(),
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
    details: z
      .object({
        attempts: z.array(
          z.object({
            model: ModelRefSchema,
            kind: ProviderFailureFamilySchema,
            status: z.number().int().nullable(),
            message: z.string(),
            provider: z.string().optional(),
            latencyMs: z.number().nonnegative().optional(),
          }),
        ),
        nextCapacity: z.string().optional(),
      })
      .optional(),
    kind: z.enum(['provider', 'tool', 'permission', 'internal', 'all_candidates_exhausted']),
  }),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;
export const MessageSchema = z.object({
  id: MessageIdSchema,
  sessionId: SessionIdSchema,
  role: z.enum(['user', 'assistant']),
  createdAt: z.iso.datetime(),
  modelRef: ModelRefSchema.nullable(),
  requestedModelRef: ModelRefSchema.or(z.literal('auto')).nullable().optional(),
  turnId: z.string().optional(),
  providerReportedModelId: z.string().nullable().optional(),
  interrupted: z.object({ reason: z.string(), at: z.iso.datetime() }).optional(),
  agentRole: z.enum(['planner', 'editor']).optional(),
  modelAttempts: z
    .array(
      z.object({
        model: ModelRefSchema,
        provider: z.string(),
        id: z.string().optional(),
        attempt: z.number().int().positive().optional(),
        providerKeyId: z.string().optional(),
        outputStarted: z.boolean().optional(),
        fallbackReason: z.string().optional(),
        upstreamModel: z.string().optional(),
        responseModel: z.string().optional(),
        status: z.number().int().nullable(),
        latencyMs: z.number().nonnegative(),
        errorKind: ProviderFailureFamilySchema.nullable(),
      }),
    )
    .optional(),
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
export const ReadOutputInputSchema = z.object({
  sessionId: SessionIdSchema,
  handle: z.string().min(1).max(200),
  range: z
    .object({
      start: z.number().int().nonnegative(),
      limit: z
        .number()
        .int()
        .positive()
        .max(32 * 1024)
        .optional(),
    })
    .optional(),
  grep: z.string().max(512).optional(),
});
export type ReadOutputInput = z.infer<typeof ReadOutputInputSchema>;
export const ReadOutputPageSchema = z.object({
  text: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  totalLength: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type ReadOutputPage = z.infer<typeof ReadOutputPageSchema>;
export const MAX_RECOVERY_OUTPUT_PAGE_BYTES = 32 * 1024;
export function readOutputPage(content: string, input: ReadOutputInput): ReadOutputPage {
  const grep = input.grep?.toLocaleLowerCase();
  const text = grep
    ? content
        .split(/(?<=\n)/)
        .filter((line) => line.toLocaleLowerCase().includes(grep))
        .join('')
    : content;
  const start = Math.min(input.range?.start ?? 0, text.length);
  const requestedEnd = Math.min(
    start + (input.range?.limit ?? MAX_RECOVERY_OUTPUT_PAGE_BYTES),
    text.length,
  );
  let end = start;
  let bytes = 0;
  for (const point of text.slice(start, requestedEnd)) {
    const size = point.codePointAt(0) ?? 0;
    const pointBytes = size <= 0x7f ? 1 : size <= 0x7ff ? 2 : size <= 0xffff ? 3 : 4;
    if (bytes + pointBytes > MAX_RECOVERY_OUTPUT_PAGE_BYTES) break;
    bytes += pointBytes;
    end += point.length;
  }
  return {
    text: text.slice(start, end),
    start,
    end,
    totalLength: text.length,
    hasMore: end < text.length,
  };
}
export const CheckpointSchema = z.object({
  id: CheckpointIdSchema,
  sessionId: SessionIdSchema,
  label: z.string(),
  createdAt: z.iso.datetime(),
  fileCount: z.number().int().nonnegative(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const CheckpointDiffSchema = z.string();
