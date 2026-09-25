import { z } from 'zod';
import {
  evaluatePermission,
  WorkspaceTools,
  editFile,
  applyPatch,
  runCommand,
  buildRepoMap,
  ShadowCheckpoints,
} from '@ferry/workspace';
import type { MessagePart, PermissionMode, TaskRecord, ToolOutput } from '@ferry/shared';
import { CheckpointIdSchema, newId, PartIdSchema } from '@ferry/shared';
import type { PermissionRule } from '@ferry/workspace';

export interface ToolContext {
  signal: AbortSignal;
  task: TaskRecord;
}

export interface AgentTool {
  name: string;
  title: string;
  schema: z.ZodType;
  mutates?: boolean;
  permission?: {
    path?: (args: unknown) => string | undefined;
    command?: (args: unknown) => string | undefined;
  };
  execute(args: unknown, context: ToolContext): unknown;
}

/** Extension contract used by future MCP and skill providers. */
export interface ToolSource {
  tools(context: {
    workspace: string;
    sessionId: string;
  }): Promise<readonly AgentTool[]> | readonly AgentTool[];
}

export interface ApprovalRequest {
  part: Extract<MessagePart, { type: 'approval_request' }>;
  signal: AbortSignal;
}

export interface ToolRegistryOptions {
  workspace: string;
  sessionId: string;
  dataDir: string;
  permissionMode: PermissionMode;
  permissionRules?: PermissionRule[];
  onPart(part: MessagePart): void;
  onOptimizerEvent?(event: {
    tool: string;
    originalTokens: number;
    filteredTokens: number;
    recoveryHandle: string | null;
  }): void;
  requestApproval(request: ApprovalRequest): Promise<'allowed_once' | 'allowed_always' | 'denied'>;
  filterOutput?: (
    tool: string,
    text: string,
  ) => Promise<{ text: string; filtered: boolean; recoveryHandle?: string }>;
  readRecovery?: (handle: string) => Promise<string | undefined>;
  sources?: readonly ToolSource[];
  updateTask(task: TaskRecord): void;
}

const ReadFileSchema = z.object({
  path: z.string(),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});
const ListDirSchema = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(20).default(1),
});
const GlobSchema = z.object({ pattern: z.string().min(1) });
const GrepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  context: z.number().int().min(0).max(10).default(0),
});
const WriteFileSchema = z.object({ path: z.string(), content: z.string() });
const EditSchema = z.object({
  path: z.string(),
  edits: z.array(z.object({ search: z.string(), replace: z.string() }).strict()).min(1),
});
const PatchSchema = z.object({ patch: z.string() });
const CommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  byteCap: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
  pty: z.boolean().optional(),
});
const PlanSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().default(''),
      text: z.string(),
      status: z.enum(['todo', 'doing', 'done', 'blocked']).default('todo'),
    }),
  ),
});
const DecisionSchema = z.object({ text: z.string(), why: z.string() });
const ReadOutputSchema = z.object({ handle: z.string() });

export function createWorkspaceTools(options: ToolRegistryOptions): {
  tools: AgentTool[];
  workspace: WorkspaceTools;
  guard(tool: AgentTool): AgentTool;
} {
  const workspace = new WorkspaceTools(options.workspace);
  const checkpoints = new ShadowCheckpoints(workspace.jail, options.dataDir);
  const checkAbort = (signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  };
  const defs: AgentTool[] = [
    {
      name: 'read_file',
      title: 'Read file',
      schema: ReadFileSchema,
      permission: { path: (a) => (a as z.infer<typeof ReadFileSchema>).path },
      execute: (a) => workspace.readFile(a),
    },
    {
      name: 'list_dir',
      title: 'List directory',
      schema: ListDirSchema,
      execute: (a) => workspace.listDir(a),
    },
    { name: 'glob', title: 'Find files', schema: GlobSchema, execute: (a) => workspace.glob(a) },
    { name: 'grep', title: 'Search files', schema: GrepSchema, execute: (a) => workspace.grep(a) },
    {
      name: 'write_file',
      title: 'Write file',
      schema: WriteFileSchema,
      mutates: true,
      permission: { path: (a) => (a as z.infer<typeof WriteFileSchema>).path },
      execute: (a) => workspace.writeFile(a),
    },
    {
      name: 'edit_file',
      title: 'Edit file',
      schema: EditSchema,
      mutates: true,
      permission: { path: (a) => (a as z.infer<typeof EditSchema>).path },
      execute: (a) => editFile(workspace, a),
    },
    {
      name: 'apply_patch',
      title: 'Apply patch',
      schema: PatchSchema,
      mutates: true,
      execute: (a) => applyPatch(workspace, a),
    },
    {
      name: 'run_command',
      title: 'Run command',
      schema: CommandSchema,
      permission: { command: (a) => (a as z.infer<typeof CommandSchema>).command },
      execute: (a) => runCommand(workspace.jail, a),
    },
    {
      name: 'repo_map',
      title: 'Map repository',
      schema: z.object({ tokenBudget: z.number().int().positive().optional() }),
      execute: (a) => buildRepoMap(workspace.jail, a),
    },
    {
      name: 'update_plan',
      title: 'Update plan',
      schema: PlanSchema,
      execute: (a, c) => {
        const input = PlanSchema.parse(a);
        options.updateTask({
          ...c.task,
          plan: input.items.map((item, i) => ({ ...item, id: item.id || `plan_${String(i + 1)}` })),
        });
        return input.items;
      },
    },
    {
      name: 'record_decision',
      title: 'Record decision',
      schema: DecisionSchema,
      execute: (a, c) => {
        const input = DecisionSchema.parse(a);
        options.updateTask({
          ...c.task,
          decisions: [...c.task.decisions, { ...input, at: new Date().toISOString() }],
        });
        return input;
      },
    },
    {
      name: 'read_output',
      title: 'Read filtered output',
      schema: ReadOutputSchema,
      execute: async (a) => {
        const input = ReadOutputSchema.parse(a);
        return (await options.readRecovery?.(input.handle)) ?? 'Recovery output is unavailable.';
      },
    },
  ];
  const guard = (definition: AgentTool): AgentTool => {
    const original = (args: unknown, context: ToolContext) => definition.execute(args, context);
    return {
      ...definition,
      execute: async (raw: unknown, context: ToolContext) => {
        checkAbort(context.signal);
        const args = definition.schema.parse(raw);
        const path = definition.permission?.path?.(args);
        const command = definition.permission?.command?.(args);
        const actionTool = definition.name;
        const decision = evaluatePermission(
          { tool: actionTool, ...(path ? { path } : {}), ...(command ? { command } : {}) },
          {
            mode: options.permissionMode,
            ...(options.permissionRules ? { rules: options.permissionRules } : {}),
            workspace: options.workspace,
          },
        );
        if (decision.decision === 'deny') throw new Error(decision.reason);
        if (decision.decision === 'ask') {
          const part = {
            type: 'approval_request' as const,
            id: PartIdSchema.parse(newId('part')),
            kind: command ? ('command' as const) : ('edit' as const),
            summary: definition.title,
            detail: command ?? path ?? definition.title,
            risk: command ? ('high' as const) : ('medium' as const),
            state: 'pending' as const,
          };
          options.onPart(part);
          const response = await options.requestApproval({ part, signal: context.signal });
          checkAbort(context.signal);
          options.onPart({ ...part, state: response });
          if (response === 'denied') throw new Error('User denied this tool call');
        }
        if (definition.mutates) {
          const id = await checkpoints.snapshot(`Before ${definition.title}`);
          options.onPart({
            type: 'checkpoint',
            id: PartIdSchema.parse(newId('part')),
            checkpointId: CheckpointIdSchema.parse(id),
            label: `Before ${definition.title}`,
          });
        }
        const value = await original(args, context);
        checkAbort(context.signal);
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        const filtered = (await options.filterOutput?.(definition.name, text)) ?? {
          text,
          filtered: false,
        };
        const output: ToolOutput = {
          text: filtered.text,
          filtered: filtered.filtered,
          originalTokens: estimateTokens(text),
          filteredTokens: estimateTokens(filtered.text),
          recoveryHandle: filtered.recoveryHandle ?? null,
        };
        if (output.filtered)
          options.onOptimizerEvent?.({
            tool: definition.name,
            originalTokens: output.originalTokens ?? estimateTokens(text),
            filteredTokens: output.filteredTokens ?? estimateTokens(output.text),
            recoveryHandle: output.recoveryHandle,
          });
        return { value, output };
      },
    };
  };
  return { tools: defs.map(guard), workspace, guard };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
