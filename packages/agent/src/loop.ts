import { streamText, tool, type ToolSet } from 'ai';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { createObservedFetch, createLanguageModel } from '@ferry/providers';
import {
  classifyStep,
  scoreModels,
  buildBriefing,
  createHandoffMarker,
  estimateTextTokens,
  type CapacityView,
  type ModelStats,
} from '@ferry/router';
import {
  newId,
  PartIdSchema,
  type Message,
  type MessagePart,
  type ModelInfo,
  type ModelRef,
  type Profile,
  type Session,
  type TaskRecord,
} from '@ferry/shared';
import type { Catalog } from '@ferry/catalog';
import type { RawCallObservation } from '@ferry/providers';
import { assembleSystemPrompt, type PromptSection } from './prompt.js';
import { SessionStore } from './session.js';
import { createWorkspaceTools, type AgentTool, type ToolSource } from './tool-registry.js';

export type AgentEvent =
  | { type: 'session.message'; message: Message }
  | { type: 'session.part'; sessionId: string; messageId: string; part: MessagePart }
  | { type: 'session.delta'; sessionId: string; messageId: string; text: string }
  | { type: 'session.updated'; session: Session }
  | { type: 'task.updated'; task: TaskRecord }
  | { type: 'quota.updated'; observation: RawCallObservation }
  | {
      type: 'optimizer.event';
      tool: string;
      originalTokens: number;
      filteredTokens: number;
      recoveryHandle: string | null;
    }
  | { type: 'toast'; message: string; tone: 'info' | 'warning' | 'error' };

export interface ModelToolCall {
  id?: string;
  name: string;
  input: unknown;
}
export interface GeneratedStep {
  text?: string;
  reasoning?: string;
  toolCalls?: ModelToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}
export interface StepGeneratorInput {
  model: ModelInfo;
  system: string;
  messages: readonly Message[];
  tools: readonly AgentTool[];
  signal: AbortSignal;
  onDelta(text: string): void;
}
export type StepGenerator = (input: StepGeneratorInput) => Promise<GeneratedStep>;
const discardDelta = (_text: string): void => undefined;

export interface AgentOptions {
  store: SessionStore;
  workspace: string;
  dataDir: string;
  profile: Profile;
  catalog: Catalog;
  capacity(): CapacityView;
  apiKeys: Readonly<Record<string, string>>;
  permissionMode: import('@ferry/shared').PermissionMode;
  permissionRules?: import('@ferry/workspace').PermissionRule[];
  emit(event: AgentEvent): void;
  requestApproval?: (
    part: Extract<MessagePart, { type: 'approval_request' }>,
    signal: AbortSignal,
  ) => Promise<'allowed_once' | 'allowed_always' | 'denied'>;
  askUser?: (question: string, signal: AbortSignal) => Promise<string>;
  generator?: StepGenerator;
  toolSources?: readonly ToolSource[];
  promptSections?: readonly PromptSection[];
  filterOutput?: (
    name: string,
    text: string,
  ) => Promise<{ text: string; filtered: boolean; recoveryHandle?: string }>;
  readRecovery?: (handle: string) => Promise<string | undefined>;
  title?: (prompt: string, signal: AbortSignal) => Promise<string>;
  maxSteps?: number;
  tokenBudget?: number;
  pinnedTurns?: number;
  estimateTokens?: (text: string) => number;
  onObservation?: (observation: RawCallObservation) => void;
  stats?: ModelStats[];
  terseLevel?: 'off' | 'lite' | 'full' | 'ultra';
}

export interface RunInput {
  sessionId: string;
  signal?: AbortSignal;
}
export interface RunResult {
  session: Session;
  taskRecord: TaskRecord;
  steps: number;
  tokens: number;
  status: 'completed' | 'paused' | 'cancelled' | 'limit';
}

export class AgentLoop {
  private readonly estimates: (text: string) => number;
  private readonly outputHandles = new Map<string, string>();

  constructor(private readonly options: AgentOptions) {
    this.estimates = options.estimateTokens ?? estimateTextTokens;
  }

  async run({ sessionId, signal: outerSignal }: RunInput): Promise<RunResult> {
    const controller = new AbortController();
    const relayAbort = () => {
      controller.abort(outerSignal?.reason);
    };
    outerSignal?.addEventListener('abort', relayAbort, { once: true });
    const signal = controller.signal;
    let loaded = this.options.store.load(sessionId);
    if (!loaded) throw new Error(`Unknown session ${sessionId}`);
    let { session, messages, taskRecord } = loaded;
    if (this.options.title && messages.filter((message) => message.role === 'user').length === 1) {
      const prompt =
        messages
          .find((message) => message.role === 'user')
          ?.parts.filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(' ') ?? taskRecord.goal;
      const title = await this.options.title(prompt, signal).catch(() => undefined);
      session = this.options.store.updateSession(sessionId, {
        title: title?.trim() ?? session.title,
      });
      this.options.emit({ type: 'session.updated', session });
    }
    let totalTokens = 0;
    let stepCount = 0;
    let contextSummary: string | undefined;
    const maxSteps = this.options.maxSteps ?? 40;
    const budget = this.options.tokenBudget ?? 100_000;
    const approvals = this.options.requestApproval;
    const registry = createWorkspaceTools({
      workspace: this.options.workspace,
      sessionId,
      dataDir: this.options.dataDir,
      permissionMode: this.options.permissionMode,
      ...(this.options.permissionRules ? { permissionRules: this.options.permissionRules } : {}),
      onPart: (part) => {
        this.addPart(sessionId, part);
      },
      onOptimizerEvent: (event) => {
        this.options.emit({ type: 'optimizer.event', ...event });
      },
      requestApproval: async ({ part, signal: toolSignal }) => {
        if (!approvals) return 'denied';
        const waiting = this.options.store.updateSession(sessionId, {
          status: 'awaiting_approval',
        });
        this.options.emit({ type: 'session.updated', session: waiting });
        const response = await approvals(part, toolSignal);
        const resumed = this.options.store.updateSession(sessionId, { status: 'running' });
        this.options.emit({ type: 'session.updated', session: resumed });
        return response;
      },
      ...(this.options.filterOutput ? { filterOutput: this.options.filterOutput } : {}),
      readRecovery: async (handle) =>
        this.outputHandles.get(handle) ?? this.options.readRecovery?.(handle),
      ...(this.options.toolSources ? { sources: this.options.toolSources } : {}),
      updateTask: (task) => {
        taskRecord = task;
        this.persistTask(task);
      },
    });
    const extensionTools = await Promise.all(
      (this.options.toolSources ?? []).map((source) =>
        Promise.resolve(source.tools({ workspace: this.options.workspace, sessionId })),
      ),
    );
    const tools = [
      ...registry.tools,
      ...extensionTools.flat().map((extension) => registry.guard(extension)),
    ];
    try {
      while (stepCount < maxSteps && totalTokens < budget) {
        if (signal.aborted)
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'cancelled');
        loaded = this.options.store.load(sessionId);
        if (!loaded) throw new Error('Session disappeared during run');
        session = loaded.session;
        messages = loaded.messages;
        taskRecord = loaded.taskRecord;
        const keepTurns = this.options.pinnedTurns ?? 8;
        const pinnedMessages = messages.slice(-keepTurns * 2);
        const recentText = renderMessages(pinnedMessages);
        const inputTokens =
          this.estimates(recentText) +
          this.estimates(JSON.stringify(taskRecord)) +
          this.estimates(contextSummary ?? '');
        const maxContext = Math.max(
          ...this.options.catalog.models.map((candidate) => candidate.contextWindow),
        );
        const routeEstimate = Math.min(inputTokens, Math.floor(maxContext * 0.55));
        const stepKind = classifyStep({
          firstStep: stepCount === 0,
          pendingEdits: taskRecord.touchedFiles.length > 0,
          estimatedInputTokens: routeEstimate,
        });
        const model = this.selectModel(stepKind, routeEstimate, session.modelRef);
        if (!model) throw new Error('No eligible model is available for this step');
        let contextMessages = contextSummary ? pinnedMessages : messages;
        if (inputTokens > model.contextWindow * 0.7) {
          const summaryModel =
            this.selectModel(
              'summarize',
              Math.min(routeEstimate, Math.floor(model.contextWindow * 0.6)),
              session.modelRef,
            ) ?? model;
          const summarize =
            this.options.generator ?? this.createStreamingGenerator(summaryModel, sessionId);
          const summaryResult = await summarize({
            model: summaryModel,
            system:
              'Summarize the conversation for continued coding work. Preserve user requirements, completed actions, key discoveries, file names, constraints, and unresolved next steps. Return only the concise summary.',
            messages,
            tools: [],
            signal,
            onDelta: discardDelta,
          });
          contextSummary = summaryResult.text?.trim() ?? contextSummary ?? '';
          if (contextSummary) {
            taskRecord = {
              ...taskRecord,
              decisions: [
                ...taskRecord.decisions.filter(
                  (decision) => decision.why !== 'Automatic context compaction',
                ),
                {
                  text: contextSummary,
                  why: 'Automatic context compaction',
                  at: new Date().toISOString(),
                },
              ],
            };
            this.persistTask(taskRecord);
          }
          totalTokens +=
            (summaryResult.inputTokens ?? routeEstimate) +
            (summaryResult.outputTokens ?? this.estimates(contextSummary));
          stepCount++;
          contextMessages = pinnedMessages;
        }
        if (session.modelRef && session.modelRef !== model.ref) {
          const briefing = buildBriefing(
            taskRecord,
            messages,
            model,
            Math.floor(model.contextWindow * 0.25),
            this.estimates,
          );
          const marker = createHandoffMarker(
            session.modelRef,
            model.ref,
            'quota',
            briefing,
            'The router selected another eligible model.',
          );
          this.addPart(sessionId, {
            type: 'handoff_marker',
            id: PartIdSchema.parse(newId('part')),
            from: marker.from as ModelRef,
            to: marker.to as ModelRef,
            reason: marker.reason,
            briefingTokens: marker.briefingTokens,
            explanation: marker.explanation,
          });
          this.options.emit({
            type: 'toast',
            tone: 'info',
            message: `Continuing with ${model.name}`,
          });
          taskRecord = {
            ...taskRecord,
            nextStep: `Continue using handoff briefing: ${briefing.text}`,
          };
          this.persistTask(taskRecord);
        }
        const selectedRef = model.ref;
        session = this.options.store.updateSession(sessionId, {
          modelRef: selectedRef,
          status: 'running',
        });
        this.options.emit({ type: 'session.updated', session });
        const system = await assembleSystemPrompt({
          workspace: this.options.workspace,
          sessionId,
          task: taskRecord,
          ...(this.options.terseLevel ? { terseLevel: this.options.terseLevel } : {}),
          ...(this.options.promptSections ? { sections: this.options.promptSections } : {}),
        });
        const assistant = this.options.store.appendMessage(sessionId, 'assistant', [], selectedRef);
        this.options.emit({ type: 'session.message', message: assistant });
        const streamedTextPartId = PartIdSchema.parse(newId('part'));
        let streamedText = '';
        const generator = this.options.generator ?? this.createStreamingGenerator(model, sessionId);
        const generated = await generator({
          model,
          system,
          messages: contextMessages,
          tools,
          signal,
          onDelta: (text) => {
            streamedText += text;
            const currentParts =
              this.options.store
                .load(sessionId)
                ?.messages.find((message) => message.id === assistant.id)?.parts ?? [];
            const partial = { type: 'text' as const, id: streamedTextPartId, text: streamedText };
            this.replaceMessageParts(assistant, [
              ...currentParts.filter((part) => part.id !== streamedTextPartId),
              partial,
            ]);
            this.options.emit({ type: 'session.delta', sessionId, messageId: assistant.id, text });
          },
        });
        let parts =
          this.options.store
            .load(sessionId)
            ?.messages.find((message) => message.id === assistant.id)?.parts ?? [];
        if (generated.reasoning)
          parts = [
            ...parts,
            { type: 'reasoning', id: PartIdSchema.parse(newId('part')), text: generated.reasoning },
          ];
        if (generated.text && streamedText)
          parts = parts.map((part) =>
            part.id === streamedTextPartId ? { ...part, text: generated.text ?? '' } : part,
          );
        else if (generated.text)
          parts = [
            ...parts,
            { type: 'text', id: PartIdSchema.parse(newId('part')), text: generated.text },
          ];
        this.replaceMessageParts(assistant, parts);
        totalTokens +=
          (generated.inputTokens ?? inputTokens) +
          (generated.outputTokens ?? this.estimates(generated.text ?? ''));
        stepCount++;
        const retryErrors: string[] = [];
        for (const call of generated.toolCalls ?? []) {
          if (call.name === 'ask_user') {
            const question =
              typeof call.input === 'string'
                ? call.input
                : isRecord(call.input) && typeof call.input.question === 'string'
                  ? call.input.question
                  : 'Please clarify the next step.';
            this.options.store.updateSession(sessionId, { status: 'idle' });
            const answer = await this.options.askUser?.(question, signal);
            if (answer === undefined)
              return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'paused');
            this.options.store.appendMessage(
              sessionId,
              'user',
              [{ type: 'text', id: PartIdSchema.parse(newId('part')), text: answer }],
              null,
            );
            break;
          }
          const definition = tools.find((candidate) => candidate.name === call.name);
          if (!definition) {
            retryErrors.push(`Unknown tool: ${call.name}`);
            continue;
          }
          const parsed = repairAndValidate(definition.schema, call.input);
          if (!parsed.ok) {
            retryErrors.push(`Invalid ${call.name} arguments: ${parsed.error}`);
            this.noteValidationFailure(selectedRef);
            continue;
          }
          const toolPart: Extract<MessagePart, { type: 'tool_call' }> = {
            type: 'tool_call',
            id: PartIdSchema.parse(newId('part')),
            tool: call.name as Extract<MessagePart, { type: 'tool_call' }>['tool'],
            title: definition.title,
            args: parsed.value as Record<string, unknown>,
            status: 'running',
            output: null,
            changes: [],
            durationMs: null,
          };
          this.addPart(sessionId, toolPart);
          const start = Date.now();
          try {
            const result = await raceAbort(
              Promise.resolve(definition.execute(parsed.value, { signal, task: taskRecord })),
              signal,
            );
            const structured = result as {
              value?: unknown;
              output?: import('@ferry/shared').ToolOutput;
            };
            const output = structured.output ?? {
              text: JSON.stringify(result),
              filtered: false,
              originalTokens: null,
              filteredTokens: null,
              recoveryHandle: null,
            };
            if (output.recoveryHandle) this.outputHandles.set(output.recoveryHandle, output.text);
            const value = structured.value ?? result;
            const changes = Array.isArray(value)
              ? value.filter(isFileChange)
              : isFileChange(value)
                ? [value]
                : [];
            const purpose = `${call.name} via Ferry tool`;
            for (const change of changes) taskRecord = touchFile(taskRecord, change.path, purpose);
            if (changes.length) this.persistTask(taskRecord);
            toolPart.status = 'succeeded';
            toolPart.output = output;
            toolPart.changes = changes.map((change) => ({
              path: change.path,
              status:
                change.before === null
                  ? ('added' as const)
                  : change.after === null
                    ? ('deleted' as const)
                    : ('modified' as const),
              additions: countLines(change.after, change.before, true),
              deletions: countLines(change.before, change.after, false),
              before: change.before,
              after: change.after,
            }));
            toolPart.durationMs = Date.now() - start;
            this.replacePart(sessionId, toolPart);
            this.noteToolCall(selectedRef);
            if (output.filtered)
              this.options.emit({
                type: 'toast',
                tone: 'info',
                message:
                  'Tool output was shortened. Use read_output with its recovery handle for the full result.',
              });
          } catch (error) {
            toolPart.status = 'failed';
            toolPart.durationMs = Date.now() - start;
            toolPart.output = {
              text: error instanceof Error ? error.message : String(error),
              filtered: false,
              originalTokens: null,
              filteredTokens: null,
              recoveryHandle: null,
            };
            this.replacePart(sessionId, toolPart);
            retryErrors.push(`Tool ${call.name} failed: ${toolPart.output.text}`);
          }
          stepCount++;
          if (stepCount >= maxSteps) break;
        }
        if (retryErrors.length)
          this.options.store.appendMessage(
            sessionId,
            'user',
            [
              {
                type: 'text',
                id: PartIdSchema.parse(newId('part')),
                text: `Tool validation/errors; retry once with corrected arguments:\n${retryErrors.join('\n')}`,
              },
            ],
            null,
          );
        if (!generated.toolCalls?.length || generated.finishReason === 'stop')
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'completed');
      }
      return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
    } catch (error) {
      if (signal.aborted)
        return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'cancelled');
      const message = error instanceof Error ? error.message : String(error);
      this.addPart(sessionId, {
        type: 'error',
        id: PartIdSchema.parse(newId('part')),
        message,
        kind: 'provider',
      });
      this.options.emit({ type: 'toast', tone: 'error', message });
      this.options.store.updateSession(sessionId, { status: 'error' });
      throw error;
    } finally {
      outerSignal?.removeEventListener('abort', relayAbort);
    }
  }

  private createStreamingGenerator(model: ModelInfo, sessionId: string): StepGenerator {
    const observationFetch = createObservedFetch(
      (observation) => {
        this.options.onObservation?.(observation);
        this.options.emit({ type: 'quota.updated', observation });
      },
      { providerId: model.providerId, model: model.ref },
    );
    // The SDK generator callback captures its model and loop scope intentionally.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    return async ({ system, messages, tools, signal, onDelta }) => {
      const sdkTools: Record<string, unknown> = Object.fromEntries(
        tools.map((definition) => [
          definition.name,
          tool({ description: definition.title, inputSchema: definition.schema }),
        ]),
      );
      if (this.options.askUser)
        sdkTools.ask_user = tool({
          description: 'Ask the user a question and pause until they answer.',
          inputSchema: z.object({ question: z.string() }),
        });
      const result = streamText({
        model: createLanguageModel(model.ref, {
          apiKey: this.options.apiKeys[model.providerId] ?? '',
          fetch: observationFetch,
          sessionId,
        }),
        system,
        prompt: renderMessages(messages),
        tools: sdkTools as unknown as ToolSet,
        abortSignal: signal,
      });
      let text = '';
      for await (const chunk of result.textStream) {
        text += chunk;
        onDelta(chunk);
      }
      const [usage, rawCalls] = await Promise.all([result.usage, result.toolCalls]);
      const calls = z
        .array(z.object({ toolCallId: z.string(), toolName: z.string(), input: z.unknown() }))
        .parse(rawCalls);
      return {
        text,
        toolCalls: calls.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          input: call.input,
        })),
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      };
    };
  }

  private selectModel(
    step: import('@ferry/shared').StepKind,
    inputTokens: number,
    previous: ModelRef | null,
  ): ModelInfo | undefined {
    const candidates = scoreModels({
      models: this.options.catalog.models,
      capacity: this.options.capacity(),
      profile: this.options.profile,
      step,
      estimate: { inputTokens, outputTokens: 2048, expectedSteps: 1, requiresTools: true },
      ...(this.options.stats ? { stats: this.options.stats } : {}),
      previousModelRef: previous,
    });
    return this.options.catalog.models.find((model) => model.ref === candidates[0]?.ref);
  }

  private finish(
    sessionId: string,
    taskRecord: TaskRecord,
    steps: number,
    tokens: number,
    status: RunResult['status'],
  ): RunResult {
    const session = this.options.store.updateSession(sessionId, {
      status: 'idle',
    });
    this.options.emit({ type: 'session.updated', session });
    return { session, taskRecord, steps, tokens, status };
  }

  private persistTask(task: TaskRecord): void {
    this.options.store.saveTask(task);
    this.options.emit({ type: 'task.updated', task });
  }
  private addPart(sessionId: string, part: MessagePart): void {
    const loaded = this.options.store.load(sessionId);
    const target = [...(loaded?.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant');
    if (!target) return;
    const existing = loaded?.messages.some((message) =>
      message.parts.some((candidate) => candidate.id === part.id),
    );
    if (existing) this.options.store.replacePart(sessionId, part);
    else this.options.store.appendPart(sessionId, target.id, part);
    this.options.emit({ type: 'session.part', sessionId, messageId: target.id, part });
  }
  private replacePart(sessionId: string, part: Extract<MessagePart, { type: 'tool_call' }>): void {
    this.options.store.replacePart(sessionId, part);
  }
  private replaceMessageParts(message: Message, parts: MessagePart[]): void {
    this.options.store.replaceMessage({ ...message, parts });
    for (const part of parts)
      this.options.emit({
        type: 'session.part',
        sessionId: message.sessionId,
        messageId: message.id,
        part,
      });
  }
  private noteValidationFailure(modelRef: string): void {
    const stats = this.options.stats?.find((item) => item.modelRef === modelRef);
    if (stats) stats.toolCallValidationFailures++;
  }

  private noteToolCall(modelRef: string): void {
    const stats = this.options.stats?.find((item) => item.modelRef === modelRef);
    if (stats) stats.toolCalls++;
  }
}

export function repairAndValidate<T>(
  schema: import('zod').ZodType<T>,
  input: unknown,
): { ok: true; value: T } | { ok: false; error: string } {
  const direct = schema.safeParse(input);
  if (direct.success) return { ok: true, value: direct.data };
  try {
    const source = typeof input === 'string' ? input : JSON.stringify(input);
    const repaired: unknown = JSON.parse(jsonrepair(source));
    const checked = schema.safeParse(repaired);
    return checked.success
      ? { ok: true, value: checked.data }
      : { ok: false, error: checked.error.message };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function touchFile(task: TaskRecord, path: string, purpose: string): TaskRecord {
  const found = task.touchedFiles.find((item) => item.path === path);
  return {
    ...task,
    touchedFiles: found
      ? task.touchedFiles.map((item) => (item.path === path ? { ...item, purpose } : item))
      : [...task.touchedFiles, { path, purpose }],
  };
}
function renderMessages(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      const parts = message.parts
        .map((part) => {
          if (part.type === 'text' || part.type === 'reasoning') return part.text;
          if (part.type === 'tool_call')
            return `Tool ${part.tool} ${part.status}: ${part.output?.text ?? JSON.stringify(part.args)}`;
          if (part.type === 'approval_request') return `Approval ${part.state}: ${part.summary}`;
          if (part.type === 'handoff_marker') return `Model handoff: ${part.explanation}`;
          if (part.type === 'checkpoint') return `Checkpoint created: ${part.label}`;
          if (part.type === 'error') return `Error (${part.kind}): ${part.message}`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
      return `${message.role}: ${parts}`;
    })
    .join('\n\n');
}
function isFileChange(
  value: unknown,
): value is { path: string; before: string | null; after: string | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    'before' in value &&
    'after' in value
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function countLines(value: string | null, other: string | null, positive: boolean): number {
  const a = value?.split(/\r\n|\n|\r/).length ?? 0;
  const b = other?.split(/\r\n|\n|\r/).length ?? 0;
  return Math.max(0, positive ? a - b : a - b);
}
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    }),
  ]);
}
