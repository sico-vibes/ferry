import {
  jsonSchema,
  streamText,
  tool,
  type JSONSchema7,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { ProviderRequestOverrides } from '@ferry/shared';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import {
  createObservedFetch,
  createLanguageModel,
  sanitizeProviderMessages,
  promptCacheOptions,
  normalizeToolSchema,
} from '@ferry/providers';
import {
  optimizeOutput,
  InMemoryBlobStore,
  readOutput,
  compactContext,
  optimizeContextMessages,
  estimateTokens as estimateOptimizerTokens,
  TERSE_LEVEL_TEXT,
} from '@ferry/optimizer';
import {
  classifyStep,
  scoreModels,
  buildBriefing,
  createHandoffMarker,
  estimateTextTokens,
  classifyProviderError,
  classifyRetryAction,
  retryDelayMs,
  shouldStopFallback,
  ResilienceLedger,
  type ResilienceEntry,
  type CapacityView,
  type ModelStats,
  StickySessionLedger,
  preferStickyAffinity,
  isToolDeferred,
  shouldRetireModel,
  type ReliabilityObservation,
  type RetirementFailure,
  type ToolRejection,
  type StickyRoute,
} from '@ferry/router';
import {
  newId,
  PartIdSchema,
  type Message,
  type MessagePart,
  type ModelInfo,
  type ModelRef,
  type ProviderFailureFamily,
  type Profile,
  type Session,
  type TaskRecord,
  type UsageRecord,
  type RoutingSettings,
  type AgentEvent as StructuredAgentEvent,
  normalizeInlineThinking,
  normalizeReasoningPart,
} from '@ferry/shared';
import type { Catalog } from '@ferry/catalog';
import type { RawCallObservation } from '@ferry/providers';
import { assembleSystemPrompt, type PromptSection } from './prompt.js';
import { SessionStore } from './session.js';
import { createWorkspaceTools, type AgentTool, type ToolSource } from './tool-registry.js';
import {
  containsOmissionPlaceholder,
  parseTextToolCallsDetailed,
  ReflectionBudget,
  ToolRepetitionDetector,
  type ModelHints,
} from './weak-model.js';
import {
  formatEditPlan,
  parseEditPlan,
  validateEditPlanPaths,
  type EditPlan,
} from './role-plan.js';

export type AgentEvent =
  | { type: 'agent.event'; sessionId: string; event: StructuredAgentEvent }
  | { type: 'session.message'; message: Message }
  | { type: 'session.part'; sessionId: string; messageId: string; part: MessagePart }
  | { type: 'session.delta'; sessionId: string; messageId: string; partId: string; text: string }
  | { type: 'session.updated'; session: Session }
  | { type: 'task.updated'; task: TaskRecord }
  | { type: 'quota.updated'; observation: RawCallObservation }
  | {
      type: 'optimizer.event';
      kind: string;
      beforeTokens: number;
      afterTokens: number;
      recoveryHandle: string | null;
    }
  | { type: 'toast'; message: string; tone: 'info' | 'warning' | 'error' };

export interface ModelToolCall {
  id?: string;
  toolCallId?: string;
  name: string;
  input: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
}
export interface GeneratedStep {
  text?: string;
  reasoning?: string;
  reasoningAvailable?: boolean;
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
  onProgress?: () => void;
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  modelHints: ModelHints;
}
export type StepGenerator = (input: StepGeneratorInput) => Promise<GeneratedStep>;
const discardDelta = (_text: string): void => undefined;

class QuotaReservationError extends Error {
  readonly statusCode = 429;

  constructor() {
    super('Quota reservation unavailable for this provider pool.');
    this.name = 'QuotaReservationError';
  }
}

class AllCandidatesExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllCandidatesExhaustedError';
  }
}

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
  modelHints?: (model: ModelInfo) => ModelHints;
  repairToolCalls?: boolean;
  promptCaching?: (model: ModelInfo) => boolean;
  providerBaseUrls?: Readonly<Record<string, string>>;
  providerFetch?: typeof globalThis.fetch;
  providerOverrides?: (model: ModelInfo) => ProviderRequestOverrides;
  toolSources?: readonly ToolSource[];
  promptSections?: readonly PromptSection[];
  filterOutput?: (
    name: string,
    text: string,
    command?: string,
    sourcePath?: string,
  ) => Promise<{ text: string; filtered: boolean; recoveryHandle?: string }>;
  readRecovery?: (handle: string) => Promise<string | undefined>;
  title?: (prompt: string, signal: AbortSignal) => Promise<string>;
  maxSteps?: number;
  maxHandoffsPerStep?: number;
  pinnedModelRef?: ModelRef | null;
  tokenBudget?: number;
  /** Maximum time without stream progress before this model attempt is abandoned. */
  stepTimeoutMs?: number;
  waitForRetry?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  pinnedTurns?: number;
  estimateTokens?: (text: string) => number;
  onObservation?: (observation: RawCallObservation) => void;
  onUsage?: (usage: UsageRecord) => void;
  authorizePaidCall?: (
    model: ModelInfo,
    estimate: { inputTokens: number; outputTokens: number },
    signal: AbortSignal,
  ) => Promise<{ allowed: boolean; message?: string; usageId?: string; release?: () => void }>;
  onHandoff?: (
    reason: 'quota' | 'rate_limit' | 'error' | 'capability',
    from: string,
    to: string,
  ) => void;
  resolveCandidates?: (
    profile: Profile,
    step: import('@ferry/shared').StepKind,
    inputTokens?: number,
  ) => ModelInfo[];
  stats?: ModelStats[];
  terseLevel?: 'off' | 'lite' | 'full' | 'ultra';
  resilienceState?: readonly ResilienceEntry[];
  onResilienceState?: (entries: ResilienceEntry[]) => void;
  routingSettings?: () => RoutingSettings;
  reliabilityState?: readonly ReliabilityObservation[];
  onReliabilityState?: (entries: ReliabilityObservation[]) => void;
  routingNow?: () => number;
  acquireQuotaLease?: (model: ModelInfo, tokens: number) => (() => void) | null;
  stickyState?: Readonly<Record<string, StickyRoute>>;
  onStickyState?: (state: Record<string, StickyRoute>) => void;
  providerAffinityKey?: (providerId: string, sessionId: string) => string | undefined;
  probeHeuristicCooldowns?: () => Promise<void>;
  toolRejectionState?: readonly ToolRejection[];
  onToolRejectionState?: (entries: ToolRejection[]) => void;
  retirementFailureState?: readonly RetirementFailure[];
  onRetirementFailureState?: (entries: RetirementFailure[]) => void;
  retiredModelRefs?: readonly string[];
  onRetiredModelRefs?: (entries: string[]) => void;
}

interface AttemptFailure {
  model: ModelRef;
  provider: string;
  kind: ProviderFailureFamily;
  status: number | null;
  latencyMs: number;
  message: string;
}

interface ModelAttempt {
  model: ModelRef;
  provider: string;
  status: number | null;
  latencyMs: number;
  errorKind: ProviderFailureFamily | null;
}

export interface RunInput {
  sessionId: string;
  signal?: AbortSignal;
  resume?: boolean;
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
  private readonly recoveryStore = new InMemoryBlobStore();
  private readonly resilience: ResilienceLedger;
  private readonly sessionModelLocks = new Map<string, Set<string>>();
  private readonly requestTooLargeAt = new Map<ModelRef, number>();
  private readonly sticky: StickySessionLedger;
  private readonly reliability: ReliabilityObservation[];
  private readonly toolRejections: ToolRejection[];
  private readonly retirementFailures: RetirementFailure[];
  private readonly retiredModels: Set<string>;
  private readonly sessionBadKeys = new Map<string, Set<string>>();
  private readonly activeMessageParts = new Map<
    string,
    { messageId: Message['id']; parts: MessagePart[] }
  >();

  constructor(private readonly options: AgentOptions) {
    this.estimates = options.estimateTokens ?? estimateTextTokens;
    this.resilience = new ResilienceLedger(options.resilienceState);
    this.reliability = [...(options.reliabilityState ?? [])];
    this.sticky = new StickySessionLedger(options.stickyState);
    this.toolRejections = [...(options.toolRejectionState ?? [])];
    this.retirementFailures = [...(options.retirementFailureState ?? [])];
    this.retiredModels = new Set(options.retiredModelRefs ?? []);
  }

  private now(): number {
    return this.options.routingNow?.() ?? Date.now();
  }

  private emitStructuredEvent(sessionId: string, event: StructuredAgentEvent): void {
    this.options.store.appendAgentEvent(sessionId, event);
    this.options.emit({ type: 'agent.event', sessionId, event });
  }

  async run({ sessionId, signal: outerSignal, resume = false }: RunInput): Promise<RunResult> {
    if (this.options.routingSettings?.().cooldownReasons)
      await this.options.probeHeuristicCooldowns?.();
    const controller = new AbortController();
    const relayAbort = () => {
      controller.abort(outerSignal?.reason);
    };
    outerSignal?.addEventListener('abort', relayAbort, { once: true });
    const signal = controller.signal;
    let loaded = this.options.store.load(sessionId);
    if (!loaded) throw new Error(`Unknown session ${sessionId}`);
    this.sessionBadKeys.set(sessionId, new Set());
    let { session, messages, taskRecord } = loaded;
    let resumedTranscript = false;
    const resumedToolResults = new Map<string, Extract<MessagePart, { type: 'tool_call' }>>();
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
    const attemptFailures: AttemptFailure[] = [];
    let contextSummary: string | undefined;
    const routingRequestId = newId('routing_request');
    const reflectionBudget = new ReflectionBudget(3);
    const repetitionDetector = new ToolRepetitionDetector();
    let nativeFormatFailures = 0;
    let pendingEditPlan: EditPlan | null = null;
    let plannerRepairHint: string | null = null;
    const rejectedPlannerMessageIds = new Set<string>();
    let activeRole: 'planner' | 'editor' | undefined;
    let editorFailures = 0;
    const maxSteps = this.options.maxSteps ?? 40;
    let rolesEnabled = this.options.profile.roles.enabled && maxSteps >= 2;
    const budget = this.options.tokenBudget ?? 100_000;
    const approvals = this.options.requestApproval;
    const registry = createWorkspaceTools({
      workspace: this.options.workspace,
      sessionId,
      stepNumber: () => stepCount + 1,
      dataDir: this.options.dataDir,
      permissionMode: this.options.permissionMode,
      ...(this.options.permissionRules ? { permissionRules: this.options.permissionRules } : {}),
      onPart: (part) => {
        if (part.type === 'approval_request') {
          const current = this.options.store
            .load(sessionId)
            ?.messages.flatMap((message) => message.parts)
            .find((existing) => existing.type === 'approval_request' && existing.id === part.id);
          if (current) {
            const message = this.options.store.replacePart(sessionId, part);
            if (message)
              this.options.emit({
                type: 'session.part',
                sessionId,
                messageId: message.id,
                part,
              });
          } else this.addPart(sessionId, part);
          return;
        }
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
        try {
          return await approvals(part, toolSignal);
        } finally {
          if (!toolSignal.aborted) {
            const resumed = this.options.store.updateSession(sessionId, { status: 'running' });
            this.options.emit({ type: 'session.updated', session: resumed });
          }
        }
      },
      filterOutput: async (name, text, command, sourcePath) => {
        if (this.options.filterOutput)
          return this.options.filterOutput(name, text, command, sourcePath);
        const result = optimizeOutput(command ?? name, text, {
          sessionId,
          blobStore: this.recoveryStore,
        });
        return {
          text: result.output,
          filtered: result.output !== text,
          ...(result.handle ? { recoveryHandle: result.handle } : {}),
        };
      },
      readRecovery: async (handle) => {
        const output = this.options.filterOutput
          ? ((await this.options.readRecovery?.(handle)) ?? readOutput(this.recoveryStore, handle))
          : (readOutput(this.recoveryStore, handle) ?? (await this.options.readRecovery?.(handle)));
        if (output !== undefined)
          this.options.emit({
            type: 'optimizer.event',
            kind: 'recovery-read',
            beforeTokens: 0,
            afterTokens: estimateOptimizerTokens(output),
            recoveryHandle: handle,
          });
        return output;
      },
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
        messages = loaded.messages.filter((message) => !rejectedPlannerMessageIds.has(message.id));
        if (resume && !resumedTranscript) {
          for (const message of loaded.messages) {
            for (const part of message.parts) {
              if (part.type === 'tool_call' && part.status === 'succeeded')
                resumedToolResults.set(part.toolCallId ?? part.id, part);
            }
          }
          messages = prepareResumeTranscript(messages);
          resumedTranscript = true;
        }
        taskRecord = loaded.taskRecord;
        const contextWindow =
          this.options.catalog.models.find((candidate) => candidate.ref === session.modelRef)
            ?.contextWindow ??
          Math.max(...this.options.catalog.models.map((candidate) => candidate.contextWindow));
        const compactedContext = compactConversationMessages(
          messages,
          contextWindow,
          this.estimates,
          this.recoveryStore,
          sessionId,
        );
        for (const event of compactedContext.events)
          this.options.emit({ type: 'optimizer.event', ...event });
        messages = compactedContext.messages;
        if (compactedContext.summary) {
          taskRecord = {
            ...taskRecord,
            decisions: [
              ...taskRecord.decisions.filter(
                (decision) => !decision.text.startsWith('Context compacted:'),
              ),
              {
                text: compactedContext.summary,
                why: 'Keep the compacted context summary in the task record.',
                at: new Date().toISOString(),
              },
            ].slice(-12),
          };
          this.persistTask(taskRecord);
        }
        attemptFailures.length = 0;
        const keepTurns = this.options.pinnedTurns ?? 4;
        const pinnedMessages = messages.slice(-keepTurns * 2);
        let system = await assembleSystemPrompt({
          workspace: this.options.workspace,
          sessionId,
          task: taskRecord,
          ...(this.options.terseLevel ? { terseLevel: this.options.terseLevel } : {}),
          ...(this.options.promptSections ? { sections: this.options.promptSections } : {}),
        });
        system +=
          '\nIf a directory or file was already inspected and the current conversation contains its result, use that result and move to an action or verification instead of repeating the same inspection.';
        if (contextSummary)
          system += `\n\nConversation summary from earlier context:\n${contextSummary}`;
        const toolSchemaTokens = this.estimates(
          JSON.stringify([
            ...tools.map((entry) => ({
              name: entry.name,
              description: entry.title,
              parameters: toolSchemaForEstimate(entry.schema),
            })),
            ...(this.options.askUser
              ? [
                  {
                    name: 'ask_user',
                    description: 'Ask the user a question and pause until they answer.',
                    parameters: z.toJSONSchema(z.object({ question: z.string() })),
                  },
                ]
              : []),
          ]),
        );
        const messageTokens = this.estimates(
          JSON.stringify(toModelMessages(pinnedMessages, this.options.catalog.models[0])),
        );
        const inputTokens = Math.ceil(
          (this.estimates(system) + messageTokens + toolSchemaTokens) * 1.15,
        );
        const routeEstimate = inputTokens;
        const stepKind = plannerRepairHint
          ? 'plan'
          : pendingEditPlan
            ? 'edit'
            : classifyStep({
                firstStep: stepCount === 0,
                pendingEdits: taskRecord.touchedFiles.length > 0,
                estimatedInputTokens: routeEstimate,
              });
        let requestedRole =
          rolesEnabled && (stepKind === 'plan' || stepKind === 'edit')
            ? stepKind === 'plan'
              ? ('planner' as const)
              : ('editor' as const)
            : undefined;
        let selectedModel = requestedRole
          ? this.selectRoleModel(
              requestedRole,
              stepKind,
              routeEstimate,
              session.modelRef,
              sessionId,
            )
          : this.selectModel(stepKind, routeEstimate, session.modelRef, sessionId);
        if (requestedRole === 'planner' && selectedModel) {
          const editor = this.selectRoleModel(
            'editor',
            'edit',
            routeEstimate,
            selectedModel.ref,
            sessionId,
          );
          if (!editor || editor.ref === selectedModel.ref) {
            rolesEnabled = false;
            requestedRole = undefined;
            selectedModel = this.selectModel(stepKind, routeEstimate, session.modelRef, sessionId);
          }
        }
        if (!selectedModel) throw new AllCandidatesExhaustedError(this.exhaustedMessage(stepKind));
        let model: ModelInfo = selectedModel;
        let contextMessages = pinnedMessages;
        if (inputTokens > model.contextWindow * 0.9) {
          if (stepCount >= maxSteps)
            return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
          const summaryModel =
            this.selectModel(
              'summarize',
              Math.min(routeEstimate, Math.floor(model.contextWindow * 0.6)),
              session.modelRef,
              sessionId,
            ) ?? model;
          const summarize =
            this.options.generator ?? this.createStreamingGenerator(summaryModel, sessionId);
          const summaryResult = await summarize({
            model: summaryModel,
            system:
              'Summarize the conversation for continued coding work. Preserve user requirements, completed actions, key discoveries, file names, constraints, and unresolved next steps. Return only the concise summary.',
            messages: pinnedMessages,
            tools: [],
            modelHints: this.options.modelHints?.(summaryModel) ?? {
              toolProtocol: 'native',
              editFormat: 'search_replace',
            },
            signal,
            onDelta: discardDelta,
          });
          contextSummary = summaryResult.text?.trim() ?? contextSummary ?? '';
          if (contextSummary) {
            system += `\n\nConversation summary from earlier context:\n${contextSummary}`;
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
        if (session.modelRef && session.modelRef !== model.ref && activeRole === requestedRole) {
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
          this.options.onHandoff?.('quota', marker.from, marker.to);
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
        let executionRole = requestedRole;
        let assistant = this.options.store.appendMessage(
          sessionId,
          'assistant',
          [],
          selectedRef,
          new Date(),
          executionRole,
        );
        this.options.emit({ type: 'session.message', message: assistant });
        const streamedTextPartId = PartIdSchema.parse(newId('part'));
        let streamedText = '';
        const streamedParts = {
          messageId: assistant.id,
          parts:
            this.options.store
              .load(sessionId)
              ?.messages.find((message) => message.id === assistant.id)?.parts ?? [],
        };
        this.activeMessageParts.set(sessionId, streamedParts);
        if (stepCount >= maxSteps)
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
        const stepRequest = (
          selected: ModelInfo,
          stepSignal: AbortSignal,
          onProgress: () => void,
        ): StepGeneratorInput => ({
          model: selected,
          system:
            executionRole === 'planner' && stepKind === 'plan'
              ? `${system}\n\nYou are the planner. Do not call tools or edit files. Return only a JSON edit plan matching this shape: {"files":[{"path":"relative/path","intent":"why this file changes"}],"changes":[{"path":"relative/path","instructions":"exact edits or a precise pseudo-diff"}]}. Include every file the editor must change. Paths must be workspace-relative and must not contain parent-directory segments, drive prefixes, or UNC/absolute paths.${plannerRepairHint ? `\n\nRepair required: ${plannerRepairHint}` : ''}`
              : executionRole === 'planner'
                ? `${system}\n\nThe editor failed repeatedly. Apply the structured edit plan directly with your own tool/edit format. Keep the change within the planned files.\n\n${formatEditPlan(pendingEditPlan ?? { files: [], changes: [] })}`
                : executionRole === 'editor' && pendingEditPlan
                  ? `${system}\n\nExecute this approved planner output with your own tool/edit format. Do not expand scope beyond the listed files and instructions.\n\n${formatEditPlan(pendingEditPlan)}`
                  : system,
          messages: contextMessages,
          tools: requestedRole === 'planner' && stepKind === 'plan' ? [] : tools,
          modelHints: this.options.modelHints?.(selected) ?? {
            toolProtocol: 'native',
            editFormat: 'search_replace',
          },
          signal: stepSignal,
          onProgress,
          onDelta: (text) => {
            if (isSignalAborted(signal)) return;
            onProgress();
            streamedText += text;
            const partial = { type: 'text' as const, id: streamedTextPartId, text: streamedText };
            const previousParts = streamedParts.parts;
            streamedParts.parts = [
              ...streamedParts.parts.filter((part) => part.id !== streamedTextPartId),
              partial,
            ];
            this.replaceMessageParts(
              assistant,
              streamedParts.parts,
              previousParts,
              streamedTextPartId,
            );
            this.options.emit({
              type: 'session.delta',
              sessionId,
              messageId: assistant.id,
              partId: streamedTextPartId,
              text,
            });
          },
        });
        let generated!: GeneratedStep;
        let generationComplete = false;
        const attemptedModels = new Set<string>([model.ref]);
        const modelAttempts: ModelAttempt[] = [];
        const toolCapabilityFailures: string[] = [];
        let sameModelRetries = 0;
        let handoffsThisStep = 0;
        let pendingPaidRelease: (() => void) | undefined;
        let pendingPaidUsageId: string | undefined;
        while (!generationComplete) {
          const attemptStartedAt = performance.now();
          try {
            const paidDecision = await this.options.authorizePaidCall?.(
              model,
              { inputTokens, outputTokens: 2048 },
              signal,
            );
            pendingPaidRelease = paidDecision?.release;
            pendingPaidUsageId = paidDecision?.usageId;
            if (paidDecision && !paidDecision.allowed) {
              this.addPart(sessionId, {
                type: 'error',
                id: PartIdSchema.parse(newId('part')),
                message: paidDecision.message ?? 'Paid model call was not authorized.',
                kind: 'all_candidates_exhausted',
              });
              return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'paused');
            }
            const generator =
              this.options.generator ?? this.createStreamingGenerator(model, sessionId);
            let releaseLease: (() => void) | null | undefined;
            const releaseOnce = () => {
              const release = releaseLease;
              releaseLease = undefined;
              release?.();
            };
            generated = await runWithStepWatchdog(
              async (input) => {
                if (
                  this.options.routingSettings?.().quotaReservations &&
                  this.options.acquireQuotaLease
                ) {
                  releaseLease = this.options.acquireQuotaLease(input.model, inputTokens + 2048);
                  if (!releaseLease) throw new QuotaReservationError();
                  try {
                    return await generator(input);
                  } finally {
                    releaseOnce();
                  }
                }
                return generator(input);
              },
              stepRequest,
              model,
              signal,
              this.options.stepTimeoutMs ?? 120_000,
              releaseOnce,
            );
            const inlineReasoning = normalizeInlineThinking(generated.text ?? '');
            if (inlineReasoning.thinking) {
              generated.text = inlineReasoning.text;
              generated.reasoning = [generated.reasoning, inlineReasoning.thinking]
                .filter(Boolean)
                .join('\n');
              generated.reasoningAvailable = true;
            }
            if (generated.text)
              this.emitStructuredEvent(sessionId, {
                id: newId('event'),
                type: 'text',
                content: generated.text,
                timestamp: new Date().toISOString(),
              });
            if (generated.reasoning)
              this.emitStructuredEvent(sessionId, {
                id: newId('event'),
                type: 'thinking',
                content: generated.reasoning,
                timestamp: new Date().toISOString(),
              });
            generationComplete = true;
            modelAttempts.push({
              model: model.ref,
              provider: model.providerId,
              status: 200,
              latencyMs: Math.max(0, performance.now() - attemptStartedAt),
              errorKind: null,
            });
            const successRouting = this.options.routingSettings?.();
            if (successRouting?.smartReliability) {
              this.reliability.push({ modelRef: model.ref, outcome: 'success', at: this.now() });
              this.pruneReliability();
              this.options.onReliabilityState?.([...this.reliability]);
            }
            if (successRouting?.stickySessions) {
              const providerKeyId = this.options.providerAffinityKey?.(model.providerId, sessionId);
              this.sticky.set(
                sessionId,
                model.ref,
                this.now(),
                successRouting.stickyTtlMinutes * 60_000,
                {
                  providerId: model.providerId,
                  ...(providerKeyId ? { providerKeyId } : {}),
                },
              );
            }
            this.options.onStickyState?.(this.sticky.snapshot());
            this.toolRejections.splice(
              0,
              this.toolRejections.length,
              ...this.toolRejections.filter((item) => item.modelRef !== model.ref),
            );
            this.options.onToolRejectionState?.([...this.toolRejections]);
            this.resilience.recordSuccess('provider', model.providerId);
            this.resilience.recordSuccess('key', model.providerId);
            this.resilience.recordSuccess('model', model.ref);
            this.options.onResilienceState?.(this.resilience.snapshot());
            break;
          } catch (error) {
            pendingPaidRelease?.();
            pendingPaidRelease = undefined;
            pendingPaidUsageId = undefined;
            if (executionRole === 'editor') editorFailures += 1;
            const classified = classifyProviderError(errorInput(error));
            const routing = this.options.routingSettings?.();
            const localQuotaReservation = error instanceof QuotaReservationError;
            if (routing?.smartReliability && !localQuotaReservation) {
              this.reliability.push({ modelRef: model.ref, outcome: 'failure', at: this.now() });
              this.pruneReliability();
              this.options.onReliabilityState?.([...this.reliability]);
            }
            if (routing?.stickySessions) {
              this.sticky.clear(sessionId);
              this.options.onStickyState?.(this.sticky.snapshot());
            }
            if (classified.family === 'tools_unsupported' && routing?.toolRejectionMemory) {
              this.toolRejections.push({
                modelRef: model.ref,
                requestId: `${routingRequestId}:${String(stepCount)}`,
                at: this.now(),
              });
              this.options.onToolRejectionState?.([...this.toolRejections]);
            }
            if (classified.family === 'model_not_found' && routing?.carefulModelRetirement) {
              const requestId = `${routingRequestId}:${String(stepCount)}`;
              if (
                shouldRetireModel(
                  classified.status,
                  redactedProviderMessage(error),
                  this.retirementFailures,
                  model.ref,
                  requestId,
                  this.now(),
                )
              ) {
                this.retiredModels.add(model.ref);
                this.options.onRetiredModelRefs?.([...this.retiredModels]);
              }
              this.retirementFailures.push({ modelRef: model.ref, requestId, at: this.now() });
              this.options.onRetirementFailureState?.([...this.retirementFailures]);
            }
            attemptFailures.push({
              model: model.ref,
              provider: model.providerId,
              kind: classified.family,
              status: classified.status,
              latencyMs: Math.max(0, performance.now() - attemptStartedAt),
              message: redactedProviderMessage(error),
            });
            modelAttempts.push({
              model: model.ref,
              provider: model.providerId,
              status: classified.status,
              latencyMs: Math.max(0, performance.now() - attemptStartedAt),
              errorKind: classified.family,
            });
            if (classified.family === 'request_too_large')
              this.requestTooLargeAt.set(model.ref, routeEstimate);
            if (isSignalAborted(signal)) throw error;
            const foreignUnsignedGeminiHistory =
              classified.family === 'request_scoped_client' &&
              classified.status === 400 &&
              isGemini3Model(model) &&
              hasForeignUnsignedToolHistory(messages, model.providerId);
            const routingFailure = foreignUnsignedGeminiHistory
              ? { ...classified, scope: 'model' as const }
              : classified;
            if (foreignUnsignedGeminiHistory) {
              const lockedModels = this.sessionModelLocks.get(sessionId) ?? new Set<string>();
              lockedModels.add(model.ref);
              this.sessionModelLocks.set(sessionId, lockedModels);
            }
            const rateLimited =
              classified.family === 'rate_limit' || classified.family === 'quota_exhausted';
            const modelUnavailable = classified.family === 'model_not_found';
            const toolsUnsupported = classified.family === 'tools_unsupported';
            const unsupportedFreeTier = classified.family === 'unsupported_free_tier';
            const requestTooLarge = classified.family === 'request_too_large';
            const timedOut = error instanceof StepWatchdogError || classified.family === 'timeout';
            const safeToSwitch = streamedText.length === 0;
            const providerPolicy = this.options
              .capacity()
              .providers.find((item) => item.id === model.providerId);
            const stopFallback = shouldStopFallback({
              pinnedModelRef: this.options.pinnedModelRef ?? null,
              attemptedModelRef: model.ref,
              avoidTrainingProviders: routing?.avoidTrainingProviders ?? false,
              providerDataUse: providerPolicy?.dataUse ?? null,
            });
            const badCredentialStatus =
              [401, 402, 403].includes(classified.status ?? 0) &&
              classified.family !== 'paid_required';
            if (badCredentialStatus) this.sessionBadKeys.get(sessionId)?.add(model.providerId);
            if (!localQuotaReservation && !badCredentialStatus && routingFailure.scope !== 'none') {
              this.resilience.recordFailure(routingFailure, model.ref, model.providerId);
            }
            if (
              !localQuotaReservation &&
              !badCredentialStatus &&
              routingFailure.scope !== 'model' &&
              classified.family !== 'request_too_large'
            )
              this.resilience.recordFailure(
                { ...routingFailure, scope: 'model' },
                model.ref,
                model.providerId,
              );
            this.options.onResilienceState?.(this.resilience.snapshot());
            const retryAction = classifyRetryAction({
              status: classified.status,
              message: classified.message,
            });
            const transient =
              (classified.status === null && classified.family !== 'offline') ||
              (classified.status !== null && classified.status >= 500) ||
              classified.family === 'timeout' ||
              classified.family === 'stream_failure';
            if (
              !requestTooLarge &&
              !rateLimited &&
              !badCredentialStatus &&
              retryAction === 'retry' &&
              transient &&
              sameModelRetries < 2
            ) {
              sameModelRetries++;
              await (this.options.waitForRetry ?? delayForRetry)(
                retryDelayMs(sameModelRetries - 1, 300, 3_000),
                signal,
              );
              continue;
            }
            if (
              (!rateLimited &&
                !modelUnavailable &&
                !toolsUnsupported &&
                !unsupportedFreeTier &&
                !timedOut &&
                !requestTooLarge &&
                routingFailure.scope === 'none') ||
              !safeToSwitch ||
              stopFallback ||
              isSignalAborted(signal)
            )
              throw error;
            if (
              executionRole === 'editor' &&
              editorFailures >= this.options.profile.roles.editorFailureThreshold
            ) {
              const planner = this.selectRoleModel(
                'planner',
                stepKind,
                routeEstimate,
                model.ref,
                sessionId,
              );
              if (planner && planner.ref !== model.ref) {
                attemptedModels.add(planner.ref);
                executionRole = 'planner';
                model = planner;
                assistant = { ...assistant, agentRole: 'planner', modelRef: planner.ref };
                this.options.store.replaceMessage(assistant);
                this.options.store.updateSession(sessionId, { modelRef: planner.ref });
                sameModelRetries = 0;
                continue;
              }
            }
            const maxHandoffs = this.options.maxHandoffsPerStep ?? 4;
            if (handoffsThisStep >= maxHandoffs)
              throw new Error(
                `Routing stopped after ${String(handoffsThisStep)} handoffs in one ${stepKind} step. ${this.routingSummary(stepKind, routeEstimate, attemptedModels)}`,
                { cause: error },
              );
            if (toolsUnsupported)
              toolCapabilityFailures.push(formatToolCapabilityFailure(model, error));
            const fallback = this.selectFallback(
              stepKind,
              routeEstimate,
              attemptedModels,
              sessionId,
            );
            if (!fallback) {
              throw new AllCandidatesExhaustedError(this.exhaustedMessage(stepKind));
            }
            attemptedModels.add(fallback.ref);
            handoffsThisStep++;
            const briefing = buildBriefing(
              taskRecord,
              messages,
              fallback,
              Math.floor(fallback.contextWindow * 0.25),
              this.estimates,
            );
            const marker = createHandoffMarker(
              model.ref,
              fallback.ref,
              toolsUnsupported ? 'capability' : rateLimited ? 'rate_limit' : 'error',
              briefing,
              toolsUnsupported
                ? `${model.name} rejected tool calling (${formatClassifiedFailure(classified.family, error)}); continuing with ${fallback.name}.`
                : rateLimited
                  ? `${model.name} returned ${formatClassifiedFailure(classified.family, error)}; continuing with ${fallback.name}.`
                  : `${model.name} failed with ${formatClassifiedFailure(classified.family, error)}; continuing with ${fallback.name}.`,
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
            this.options.onHandoff?.(
              toolsUnsupported ? 'capability' : rateLimited ? 'rate_limit' : 'error',
              marker.from,
              marker.to,
            );
            model = fallback;
            sameModelRetries = 0;
            system += `\n\nHandoff briefing:\n${briefing.text}`;
            this.options.store.updateSession(sessionId, { modelRef: fallback.ref });
          }
        }
        this.activeMessageParts.delete(sessionId);
        if (this.options.terseLevel && this.options.terseLevel !== 'off') {
          const tersePromptTokens = estimateOptimizerTokens(
            TERSE_LEVEL_TEXT[
              this.options.terseLevel === 'lite'
                ? 'Lite'
                : this.options.terseLevel === 'full'
                  ? 'Full'
                  : 'Ultra'
            ],
          );
          this.options.emit({
            type: 'optimizer.event',
            kind: 'terse-prompt',
            beforeTokens: estimateOptimizerTokens(TERSE_LEVEL_TEXT.Off),
            afterTokens: tersePromptTokens,
            recoveryHandle: null,
          });
          const responseTokens =
            generated.outputTokens ?? estimateOptimizerTokens(generated.text ?? '');
          this.options.emit({
            type: 'optimizer.event',
            kind: 'terse-response',
            beforeTokens: responseTokens,
            afterTokens: responseTokens,
            recoveryHandle: null,
          });
        }
        this.options.onUsage?.({
          id: pendingPaidUsageId ?? newId('usage'),
          providerId: model.providerId,
          modelRef: model.ref,
          occurredAt: new Date().toISOString(),
          sessionId,
          stepKind,
          inputTokens: generated.inputTokens ?? 0,
          outputTokens: generated.outputTokens ?? 0,
          status: 'success',
        });
        this.emitStructuredEvent(sessionId, {
          id: newId('event'),
          type: 'usage',
          inputTokens: generated.inputTokens ?? 0,
          outputTokens: generated.outputTokens ?? 0,
          timestamp: new Date().toISOString(),
        });
        pendingPaidRelease?.();
        pendingPaidRelease = undefined;
        pendingPaidUsageId = undefined;
        if (isSignalAborted(signal))
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        let parts =
          this.options.store
            .load(sessionId)
            ?.messages.find((message) => message.id === assistant.id)?.parts ?? [];
        if (generated.reasoningAvailable === false)
          this.emitStructuredEvent(sessionId, {
            id: newId('event'),
            type: 'status',
            status: 'reasoning_unavailable',
            message: 'This model did not expose reasoning content.',
            reasoningAvailable: false,
            timestamp: new Date().toISOString(),
          });
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
        this.options.store.replaceMessage({ ...assistant, parts, modelAttempts });
        for (const part of parts)
          this.options.emit({
            type: 'session.part',
            sessionId,
            messageId: assistant.id,
            part,
          });
        totalTokens +=
          (generated.inputTokens ?? inputTokens) +
          (generated.outputTokens ?? this.estimates(generated.text ?? ''));
        stepCount++;
        if (requestedRole === 'planner' && executionRole === 'planner' && stepKind === 'plan') {
          const parsedPlan = parseEditPlan(generated.text ?? '');
          if (!parsedPlan) {
            pendingEditPlan = null;
            plannerRepairHint = null;
            rolesEnabled = false;
            taskRecord = {
              ...taskRecord,
              nextStep:
                'Planner output did not match the edit-plan contract; continue in single-model mode.',
            };
            this.persistTask(taskRecord);
            continue;
          }
          const validated = await validateEditPlanPaths(parsedPlan, this.options.workspace);
          if (!validated.plan) {
            rejectedPlannerMessageIds.add(assistant.id);
            pendingEditPlan = null;
            plannerRepairHint = `The previous plan contained ${String(validated.rejectedCount)} rejected or undeclared path entr${validated.rejectedCount === 1 ? 'y' : 'ies'}. Return a corrected plan using only safe workspace-relative paths.`;
            taskRecord = {
              ...taskRecord,
              nextStep: 'Planner must repair unsafe or undeclared file paths before editing.',
            };
            this.persistTask(taskRecord);
            continue;
          }
          const plan = validated.plan;
          plannerRepairHint = null;
          pendingEditPlan = plan;
          activeRole = requestedRole;
          taskRecord = {
            ...taskRecord,
            touchedFiles: plan.files.map(({ path, intent }) => ({ path, purpose: intent })),
            nextStep: 'Editor should apply the structured planner instructions.',
          };
          this.persistTask(taskRecord);
          continue;
        }
        if (requestedRole === 'editor') {
          pendingEditPlan = null;
          activeRole = requestedRole;
          editorFailures = 0;
        }
        const retryErrors: string[] = [];
        const calls = [...(generated.toolCalls ?? [])];
        const hints = this.options.modelHints?.(model) ?? {
          toolProtocol: 'native' as const,
          editFormat: 'search_replace',
        };
        let repeatedCallDetected = false;
        if (!calls.length && generated.text && (this.options.repairToolCalls ?? true)) {
          const parsed = parseTextToolCallsDetailed(
            generated.text,
            tools.map((entry) => entry.name),
            collectUntrustedPromptText(contextMessages),
          );
          const parsedCalls = parsed.calls;
          retryErrors.push(...parsed.hints);
          if (hints.toolProtocol !== 'native') calls.push(...parsedCalls);
          else if (parsedCalls.length) {
            nativeFormatFailures++;
            if (nativeFormatFailures >= 2) calls.push(...parsedCalls);
            else {
              this.options.store.appendMessage(
                sessionId,
                'user',
                [
                  {
                    type: 'text',
                    id: PartIdSchema.parse(newId('part')),
                    text: 'A tool call was written as text, but this model is configured for native calls. Retry once using a native tool call; if that fails again, Ferry will repair the text call.',
                  },
                ],
                null,
              );
              continue;
            }
          }
        }
        for (const call of calls) {
          if (isSignalAborted(signal))
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
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
          if (repetitionDetector.observe(call.name, call.input)) {
            repeatedCallDetected = true;
            retryErrors.push(
              'Repeated ' +
                call.name +
                ' call with identical arguments detected three times; stop repeating and choose a different action.',
            );
            continue;
          }
          if (
            /^(write_file|create_file)$/i.test(call.name) &&
            containsOmissionPlaceholder(call.input)
          ) {
            retryErrors.push(
              'Rejected ' +
                call.name +
                ': content contains an omission placeholder. Provide the complete file contents instead.',
            );
            continue;
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
          const persistedToolCallId = call.toolCallId ?? call.id;
          const persisted = persistedToolCallId
            ? resumedToolResults.get(persistedToolCallId)
            : undefined;
          if (resume && persisted?.tool === call.name) {
            this.addPart(sessionId, {
              ...persisted,
              id: PartIdSchema.parse(newId('part')),
              ...(persistedToolCallId ? { toolCallId: persistedToolCallId } : {}),
            });
            continue;
          }
          const toolPart: Extract<MessagePart, { type: 'tool_call' }> = {
            type: 'tool_call',
            id: PartIdSchema.parse(newId('part')),
            ...(call.toolCallId || call.id ? { toolCallId: call.toolCallId ?? call.id } : {}),
            ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
            tool: call.name,
            title: definition.title,
            args: parsed.value as Record<string, unknown>,
            status: 'running',
            output: null,
            changes: [],
            durationMs: null,
          };
          this.addPart(sessionId, toolPart);
          const start = Date.now();
          const eventCallId = call.toolCallId ?? call.id ?? toolPart.id;
          this.emitStructuredEvent(sessionId, {
            id: newId('event'),
            type: 'tool_use',
            callId: eventCallId,
            tool: call.name,
            input: parsed.value,
            timestamp: new Date().toISOString(),
          });
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
            this.emitStructuredEvent(sessionId, {
              id: newId('event'),
              type: 'tool_result',
              callId: eventCallId,
              output: output.text,
              timestamp: new Date().toISOString(),
              durationMs: toolPart.durationMs,
              truncated: output.filtered,
              ...(output.recoveryHandle ? { recoveryHandle: output.recoveryHandle } : {}),
            });
            this.noteToolCall(selectedRef);
            if (output.filtered)
              this.options.emit({
                type: 'toast',
                tone: 'info',
                message:
                  'Tool output was shortened. Use read_output with its recovery handle for the full result.',
              });
          } catch (error) {
            if (isSignalAborted(signal)) throw error;
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
            this.emitStructuredEvent(sessionId, {
              id: newId('event'),
              type: 'tool_result',
              callId: eventCallId,
              output: toolPart.output.text,
              timestamp: new Date().toISOString(),
              durationMs: toolPart.durationMs,
            });
            retryErrors.push(`Tool ${call.name} failed: ${toolPart.output.text}`);
          }
        }
        if (isSignalAborted(signal))
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        if (retryErrors.length && reflectionBudget.consume())
          this.options.store.appendMessage(
            sessionId,
            'user',
            [
              {
                type: 'text',
                id: PartIdSchema.parse(newId('part')),
                text:
                  'Tool validation/errors; retry once (reflection ' +
                  String(reflectionBudget.maximum - reflectionBudget.remaining) +
                  '/3) with corrected arguments. Correct the exact failures below:\n' +
                  retryErrors.join('\n'),
              },
            ],
            null,
          );
        else if (retryErrors.length) {
          this.options.store.appendMessage(
            sessionId,
            'user',
            [
              {
                type: 'text',
                id: PartIdSchema.parse(newId('part')),
                text:
                  'Stopped after the three-reflection repair limit. Failures: ' +
                  retryErrors.join('\n'),
              },
            ],
            null,
          );
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
        }
        if (repeatedCallDetected)
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
        if (!calls.length || generated.finishReason === 'stop')
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'completed');
      }
      return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
    } catch (error) {
      if (signal.aborted)
        return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'cancelled');
      const cause = rootErrorCause(error);
      const classified = classifyProviderError(errorInput(cause));
      const providerDetail = formatClassifiedFailure(classified.family, cause);
      const poolExhausted =
        error instanceof AllCandidatesExhaustedError ||
        (error instanceof Error && error.message.startsWith('All free candidates exhausted.'));
      const message = poolExhausted
        ? error.message
        : formatAttemptSummary(attemptFailures, providerDetail);
      this.emitStructuredEvent(sessionId, {
        id: newId('event'),
        type: 'error',
        message,
        timestamp: new Date().toISOString(),
      });
      const nextCapacity = poolExhausted
        ? message.split('Next free capacity: ')[1]?.replace(/\. Wait or add a provider\.$/, '')
        : undefined;
      this.addPart(sessionId, {
        type: 'error',
        id: PartIdSchema.parse(newId('part')),
        message,
        details: { attempts: attemptFailures, ...(nextCapacity ? { nextCapacity } : {}) },
        kind: poolExhausted ? 'all_candidates_exhausted' : 'provider',
      });
      const failedMessage = this.options.store.load(sessionId)?.messages.at(-1);
      if (failedMessage)
        this.options.store.replaceMessage({
          ...failedMessage,
          modelAttempts: attemptFailures.map((attempt) => ({
            model: attempt.model,
            provider: attempt.provider,
            status: attempt.status,
            latencyMs: attempt.latencyMs,
            errorKind: attempt.kind,
          })),
        });
      this.options.emit({ type: 'toast', tone: 'error', message });
      const failedSession = this.options.store.updateSession(sessionId, {
        status: 'error',
      });
      this.options.emit({ type: 'session.updated', session: failedSession });
      throw error;
    } finally {
      this.sessionBadKeys.delete(sessionId);
      outerSignal?.removeEventListener('abort', relayAbort);
    }
  }

  private createStreamingGenerator(model: ModelInfo, sessionId: string): StepGenerator {
    return createStepGenerator(this.options, model, sessionId);
  }

  private exhaustedMessage(step: import('@ferry/shared').StepKind): string {
    const earliest = this.resilience.earliest(this.now());
    const provider = earliest
      ? (this.options.capacity().providers.find((item) => item.id === earliest.key)?.name ??
        earliest.key)
      : null;
    const minutes = earliest
      ? Math.max(1, Math.ceil((Date.parse(earliest.expiresAt) - this.now()) / 60_000))
      : null;
    const reset =
      provider && minutes ? `${provider} in ${String(minutes)} min` : 'when a free provider resets';
    return `All free candidates exhausted for ${step}. Next free capacity: ${reset}. Wait or add a provider.`;
  }

  private pruneReliability(): void {
    const oldest = this.now() - 7 * 24 * 60 * 60_000;
    this.reliability.splice(
      0,
      this.reliability.length,
      ...this.reliability.filter((item) => item.at >= oldest),
    );
  }

  private selectRoleModel(
    role: 'planner' | 'editor',
    step: import('@ferry/shared').StepKind,
    inputTokens: number,
    previous: ModelRef | null,
    sessionId: string,
  ): ModelInfo | undefined {
    // A manual pin applies to every model request, including planner and editor steps.
    if (this.options.pinnedModelRef)
      return this.selectModel(step, inputTokens, previous, sessionId);
    const configured =
      role === 'planner'
        ? this.options.profile.roles.plannerModelRef
        : this.options.profile.roles.editorModelRef;
    const baseline = this.selectModel(step, inputTokens, previous, sessionId);
    const candidates = scoreModels({
      models: this.options.catalog.models,
      capacity: this.options.capacity(),
      profile: this.options.profile,
      step,
      estimate: {
        inputTokens,
        contextTokens: this.contextFitEstimate(inputTokens),
        outputTokens: 2048,
        requiresTools: role === 'editor',
      },
      ...(this.options.stats ? { stats: this.options.stats } : {}),
      ...(this.options.routingSettings ? { routing: this.options.routingSettings() } : {}),
      ...(this.reliability.length ? { reliability: this.reliability } : {}),
    });
    const models = candidates.flatMap(({ ref }) => {
      const model = this.options.catalog.models.find((candidate) => candidate.ref === ref);
      return model ? [model] : [];
    });
    const stats = this.options.stats ?? [];
    models.sort((left, right) =>
      role === 'planner'
        ? (right.quality ?? 0.35) * (right.qualityConfidence ?? 0.1) -
          (right.qualityPenalty ?? 0) -
          ((left.quality ?? 0.35) * (left.qualityConfidence ?? 0.1) - (left.qualityPenalty ?? 0))
        : Number(right.toolCalling) - Number(left.toolCalling) ||
          (stats.find((item) => item.modelRef === left.ref)?.toolCallValidationFailures ?? 0) -
            (stats.find((item) => item.modelRef === right.ref)?.toolCallValidationFailures ?? 0) ||
          (stats.find((item) => item.modelRef === left.ref)?.averageLatencyMs ?? 2000) -
            (stats.find((item) => item.modelRef === right.ref)?.averageLatencyMs ?? 2000),
    );
    const preferred = configured ? models.find((model) => model.ref === configured) : undefined;
    if (preferred) return this.selectResilient([preferred]);
    return this.selectResilient(models.length ? models : baseline ? [baseline] : []);
  }

  private selectModel(
    step: import('@ferry/shared').StepKind,
    inputTokens: number,
    previous: ModelRef | null,
    sessionId: string,
  ): ModelInfo | undefined {
    if (this.options.pinnedModelRef)
      return this.options.catalog.models.find((model) => model.ref === this.options.pinnedModelRef);
    const locked = this.sessionModelLocks.get(sessionId);
    const withinFailedSize = (model: ModelInfo) =>
      (this.requestTooLargeAt.get(model.ref) ?? Number.POSITIVE_INFINITY) <= inputTokens;
    const routing = this.options.routingSettings?.();
    const stickyRoute = routing?.stickySessions
      ? this.sticky.getRoute(sessionId, this.now())
      : undefined;
    const stickyRef = stickyRoute?.modelRef;
    const eligible = (model: ModelInfo) =>
      !this.sessionBadKeys.get(sessionId)?.has(model.providerId) &&
      !locked?.has(model.ref) &&
      !(routing?.carefulModelRetirement && this.retiredModels.has(model.ref)) &&
      !withinFailedSize(model);
    const resolved = this.options.resolveCandidates?.(this.options.profile, step, inputTokens);
    if (resolved)
      return this.selectResilient(
        preferStickyAffinity(
          resolved.filter(eligible),
          stickyRoute,
          this.options.profile.affinityMode,
          (providerId) => this.options.providerAffinityKey?.(providerId, sessionId) ?? undefined,
        ),
      );
    const candidates = scoreModels({
      models: this.options.catalog.models,
      capacity: this.options.capacity(),
      profile: this.options.profile,
      step,
      estimate: {
        inputTokens,
        contextTokens: this.contextFitEstimate(inputTokens),
        outputTokens: 2048,
        expectedSteps: 1,
        requiresTools: true,
      },
      ...(this.options.stats ? { stats: this.options.stats } : {}),
      ...(routing ? { routing } : {}),
      ...(this.reliability.length ? { reliability: this.reliability } : {}),
      previousModelRef: stickyRef ?? previous,
    });
    const selected = this.selectResilient(
      candidates.flatMap((item) => {
        if (
          this.sessionBadKeys
            .get(sessionId)
            ?.has(
              this.options.catalog.models.find((candidate) => candidate.ref === item.ref)
                ?.providerId ?? '',
            ) ||
          locked?.has(item.ref) ||
          (routing?.carefulModelRetirement && this.retiredModels.has(item.ref)) ||
          (this.requestTooLargeAt.get(item.ref) ?? Infinity) <= inputTokens
        )
          return [];
        const model = this.options.catalog.models.find((candidate) => candidate.ref === item.ref);
        return model ? [model] : [];
      }),
    );
    return selected;
  }

  private selectFallback(
    step: import('@ferry/shared').StepKind,
    inputTokens: number,
    attemptedRefs: ReadonlySet<string>,
    sessionId: string,
  ): ModelInfo | undefined {
    if (this.options.pinnedModelRef) return undefined;
    const locked = this.sessionModelLocks.get(sessionId);
    const candidates = this.options.resolveCandidates?.(this.options.profile, step, inputTokens);
    const retirementEnabled = this.options.routingSettings?.().carefulModelRetirement;
    if (candidates)
      return this.selectResilient(
        candidates.filter(
          (candidate) =>
            !this.sessionBadKeys.get(sessionId)?.has(candidate.providerId) &&
            !attemptedRefs.has(candidate.ref) &&
            !locked?.has(candidate.ref) &&
            !(retirementEnabled && this.retiredModels.has(candidate.ref)) &&
            (this.requestTooLargeAt.get(candidate.ref) ?? Number.POSITIVE_INFINITY) > inputTokens,
        ),
      );
    const previousModelRef = [...attemptedRefs].at(-1);
    const ranked = scoreModels({
      models: this.options.catalog.models,
      capacity: this.options.capacity(),
      profile: this.options.profile,
      step,
      estimate: {
        inputTokens,
        contextTokens: this.contextFitEstimate(inputTokens),
        requiresTools: true,
      },
      ...(previousModelRef ? { previousModelRef } : {}),
      ...(this.options.routingSettings ? { routing: this.options.routingSettings() } : {}),
      ...(this.reliability.length ? { reliability: this.reliability } : {}),
    });
    const remaining = ranked.flatMap((candidate) => {
      if (
        this.sessionBadKeys.get(sessionId)?.has(candidate.ref.split('/')[0] ?? '') ||
        attemptedRefs.has(candidate.ref) ||
        locked?.has(candidate.ref) ||
        (this.requestTooLargeAt.get(candidate.ref) ?? Number.POSITIVE_INFINITY) <= inputTokens
      )
        return [];
      const model = this.options.catalog.models.find((entry) => entry.ref === candidate.ref);
      return model ? [model] : [];
    });
    return this.selectResilient(remaining);
  }

  private selectResilient(models: readonly ModelInfo[]): ModelInfo | undefined {
    const now = this.now();
    const routing = this.options.routingSettings?.();
    const eligibleModels = routing?.carefulModelRetirement
      ? models.filter((model) => !this.retiredModels.has(model.ref))
      : models;
    const deferred = routing?.toolRejectionMemory
      ? new Set(
          eligibleModels
            .filter((model) => isToolDeferred(this.toolRejections, model.ref, now))
            .map((model) => model.ref),
        )
      : new Set<string>();
    const ranked = eligibleModels.map((model, index) => {
      const providerId = model.providerId as string;
      const active = [
        this.resilience.active('model', model.ref),
        this.resilience.active('key', providerId),
        this.resilience.active('provider', providerId),
      ].filter((entry): entry is ResilienceEntry => entry !== undefined);
      return {
        model,
        index,
        deferred: deferred.has(model.ref),
        reset: active.length ? Math.max(...active.map((entry) => Date.parse(entry.expiresAt))) : 0,
      };
    });
    const availableRefs = new Set(
      this.resilience.availableModelRefs(ranked.map(({ model }) => model.ref)),
    );
    const unlocked = ranked.filter((entry) => availableRefs.has(entry.model.ref));
    const ready = unlocked.find((entry) => entry.reset === 0 && !entry.deferred);
    if (ready) return ready.model;
    return unlocked.sort(
      (a, b) => Number(a.deferred) - Number(b.deferred) || a.reset - b.reset || a.index - b.index,
    )[0]?.model;
  }

  private routingSummary(
    step: import('@ferry/shared').StepKind,
    inputTokens: number,
    attemptedRefs: ReadonlySet<string>,
  ): string {
    const models =
      this.options.resolveCandidates?.(this.options.profile, step, inputTokens) ??
      this.options.catalog.models;
    const ranked = scoreModels({
      models,
      capacity: this.options.capacity(),
      profile: this.options.profile,
      step,
      estimate: {
        inputTokens,
        contextTokens: this.contextFitEstimate(inputTokens),
        outputTokens: 2048,
        expectedSteps: 1,
        requiresTools: true,
      },
      ...(this.options.stats ? { stats: this.options.stats } : {}),
    });
    const summary = ranked
      .slice(0, 8)
      .map(
        ({ ref, score, scoreBreakdown }) =>
          `${ref}=${score.toFixed(1)} ${JSON.stringify(scoreBreakdown)}`,
      )
      .join('; ');
    return `Attempted: ${[...attemptedRefs].join(', ')}. Ranked candidates: ${summary || 'none'}.`;
  }

  private finish(
    sessionId: string,
    taskRecord: TaskRecord,
    steps: number,
    tokens: number,
    status: RunResult['status'],
  ): RunResult {
    if (status === 'limit')
      this.options.emit({
        type: 'toast',
        tone: 'warning',
        message: `FERRY_RUN_LIMIT:${steps >= (this.options.maxSteps ?? 40) ? 'max_steps' : 'token_budget'}:${String(steps)}`,
      });
    const session = this.options.store.updateSession(sessionId, {
      status: 'idle',
      inFlight: false,
    });
    this.emitStructuredEvent(sessionId, {
      id: newId('event'),
      type: 'status',
      status,
      message: `Agent run ${status}.`,
      timestamp: new Date().toISOString(),
    });
    this.options.emit({ type: 'session.updated', session });
    return { session, taskRecord, steps, tokens, status };
  }

  private contextFitEstimate(inputTokens: number): number {
    const maxContext = Math.max(...this.options.catalog.models.map((model) => model.contextWindow));
    return Math.min(inputTokens, Math.floor(maxContext * 0.55));
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
    const streamed = this.activeMessageParts.get(sessionId);
    if (streamed?.messageId === target.id) {
      streamed.parts = [...streamed.parts.filter((candidate) => candidate.id !== part.id), part];
    }
    this.options.emit({ type: 'session.part', sessionId, messageId: target.id, part });
  }
  private replacePart(sessionId: string, part: MessagePart): void {
    const updated = this.options.store.replacePart(sessionId, part);
    if (updated)
      this.options.emit({
        type: 'session.part',
        sessionId,
        messageId: updated.id,
        part,
      });
  }
  private replaceMessageParts(
    message: Message,
    parts: MessagePart[],
    previousParts: MessagePart[],
    incrementalPartId: MessagePart['id'],
  ): void {
    this.options.store.replaceMessage({ ...message, parts });
    const previousById = new Map(previousParts.map((part) => [part.id, part]));
    for (const part of parts) {
      const prior = previousById.get(part.id);
      if (prior === part) continue;
      if (part.id === incrementalPartId) continue;
      this.options.emit({
        type: 'session.part',
        sessionId: message.sessionId,
        messageId: message.id,
        part,
      });
    }
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

/** Provider SDK generator exposed for the Core ModelGateway seam. */
export function createStepGenerator(
  options: Pick<
    AgentOptions,
    | 'apiKeys'
    | 'providerBaseUrls'
    | 'providerFetch'
    | 'emit'
    | 'onObservation'
    | 'askUser'
    | 'promptCaching'
  > &
    Pick<AgentOptions, 'providerOverrides'>,
  model: ModelInfo,
  sessionId: string,
): StepGenerator {
  const requestOverrides = options.providerOverrides?.(model);
  const observationFetch = createObservedFetch(
    (observation) => {
      options.onObservation?.(observation);
      options.emit({ type: 'quota.updated', observation });
    },
    { providerId: model.providerId, model: model.ref },
    options.providerFetch ?? globalThis.fetch,
    requestOverrides,
  );
  return async ({
    system,
    messages,
    tools,
    signal,
    onDelta,
    onReasoning,
    onProgress,
    modelHints,
  }) => {
    const sdkTools: Record<string, unknown> = Object.fromEntries(
      tools.map((definition) => [
        definition.name,
        tool({
          description: definition.title,
          inputSchema: jsonSchema(
            normalizeToolSchema(
              toolSchemaForEstimate(definition.schema),
              model.providerId,
            ) as JSONSchema7,
          ),
        }),
      ]),
    );
    if (options.askUser)
      sdkTools.ask_user = tool({
        description: 'Ask the user a question and pause until they answer.',
        inputSchema: z.object({ question: z.string() }),
      });
    const result = streamText({
      model: createLanguageModel(model.ref, {
        apiKey: options.apiKeys[model.providerId] ?? '',
        ...(options.providerBaseUrls?.[model.providerId]
          ? { baseUrl: options.providerBaseUrls[model.providerId] }
          : {}),
        fetch: observationFetch,
        sessionId,
      }),
      system,
      ...(Object.keys(
        promptCacheOptions(model.providerId, options.promptCaching?.(model) ?? true, sessionId),
      ).length
        ? {
            providerOptions: {
              [model.providerId]: promptCacheOptions(
                model.providerId,
                options.promptCaching?.(model) ?? true,
                sessionId,
              ),
            },
          }
        : {}),
      messages: sanitizeProviderMessages(
        toModelMessages(messages, model, modelHints.toolProtocol !== 'native'),
        model.providerId as import('@ferry/providers').MessageNormalizationProvider,
      ),
      tools: sdkTools as unknown as ToolSet,
      abortSignal: signal,
      maxRetries: 0,
      onError: () => undefined,
    });
    let text = '';
    let reasoning = '';
    let reasoningAvailable = false;
    for await (const part of result.stream) {
      onProgress?.();
      if (part.type === 'error') throw part.error;
      const streamPart = part as unknown as {
        type: string;
        text?: string;
        delta?: string;
        reasoning?: string;
        reasoning_content?: string;
        thought?: boolean;
      };
      const exposedReasoning =
        normalizeReasoningPart(streamPart) ??
        streamPart.reasoning_content ??
        (streamPart.type === 'reasoning-delta' ||
        streamPart.type === 'reasoning' ||
        streamPart.thought
          ? (streamPart.delta ?? streamPart.text ?? streamPart.reasoning)
          : undefined);
      if (typeof exposedReasoning === 'string' && exposedReasoning) {
        reasoningAvailable = true;
        reasoning += exposedReasoning;
        onReasoning?.(exposedReasoning);
      } else if (streamPart.type === 'text-delta' && typeof streamPart.text === 'string') {
        text += streamPart.text;
        onDelta(streamPart.text);
      }
    }
    const [usage, rawCalls] = await Promise.all([result.usage, result.toolCalls]);
    const calls = z
      .array(
        z.object({
          toolCallId: z.string(),
          toolName: z.string(),
          input: z.unknown(),
          providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
          providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        }),
      )
      .parse(rawCalls);
    return {
      text,
      ...(reasoning ? { reasoning } : {}),
      reasoningAvailable,
      toolCalls: calls.map((call) => {
        const providerOptions = call.providerOptions ?? call.providerMetadata;
        return {
          id: call.toolCallId,
          toolCallId: call.toolCallId,
          name: call.toolName,
          input: call.input,
          ...(providerOptions ? { providerOptions } : {}),
        };
      }),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    };
  };
}

function toolSchemaForEstimate(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return { description: schema.description ?? 'Tool input schema' };
  }
}

function prepareResumeTranscript(messages: readonly Message[]): Message[] {
  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') lastUserIndex = index;
    if (messages[index]?.role === 'assistant') lastAssistantIndex = index;
  }
  if (lastAssistantIndex <= lastUserIndex) return [...messages];
  const lastAssistant = messages[lastAssistantIndex];
  if (!lastAssistant) return [...messages];
  const tools = lastAssistant.parts.filter((part) => part.type === 'tool_call');
  if (!tools.length) return messages.filter((_message, index) => index !== lastAssistantIndex);
  if (tools.every((part) => !['pending', 'running'].includes(part.status))) return [...messages];
  const durableTools = tools.filter((part) => !['pending', 'running'].includes(part.status));
  if (!durableTools.length)
    return messages.filter((_message, index) => index !== lastAssistantIndex);
  return messages.map((message, index) =>
    index === lastAssistantIndex ? { ...message, parts: durableTools } : message,
  );
}
function toModelMessages(
  messages: readonly Message[],
  targetModel: ModelInfo | undefined,
  escapeToolResults = false,
): ModelMessage[] {
  const prompt: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const content = message.parts
        .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (content) prompt.push({ role: 'user', content });
      continue;
    }

    const content: Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> = [];
    const toolResults: Extract<ModelMessage, { role: 'tool' }>['content'] = [];
    for (const part of message.parts) {
      if (part.type === 'text' || part.type === 'reasoning') {
        if (part.text) content.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool_call') {
        if (part.status === 'succeeded' && JSON.stringify(part.args).length > 1_200) {
          const path = typeof part.args.path === 'string' ? ` for ${part.args.path}` : '';
          content.push({
            type: 'text',
            text: `${part.tool}${path} completed; large tool arguments were omitted. ${compactToolHistoryText(part.output?.text ?? '')}`.trim(),
          });
          continue;
        }
        const toolCallId = part.toolCallId ?? part.id;
        const providerOptions = withGemini3ThoughtSignature(part.providerOptions, targetModel);
        content.push({
          type: 'tool-call',
          toolCallId,
          toolName: part.tool,
          input: part.args,
          ...(providerOptions
            ? { providerOptions: providerOptions as { google?: { thoughtSignature?: string } } }
            : {}),
        });
        toolResults.push({
          type: 'tool-result',
          toolCallId,
          toolName: part.tool,
          output: {
            type: 'text',
            value: escapeToolResults
              ? wrapUntrustedToolResult(
                  compactToolHistoryText(
                    part.output?.text ?? `Tool ended with status ${part.status}.`,
                  ) +
                    (part.output?.recoveryHandle
                      ? `\n[Recovery handle: ${part.output.recoveryHandle}]`
                      : ''),
                )
              : compactToolHistoryText(
                  part.output?.text ?? `Tool ended with status ${part.status}.`,
                ) +
                (part.output?.recoveryHandle
                  ? `\n[Recovery handle: ${part.output.recoveryHandle}]`
                  : ''),
          },
        });
      } else {
        const text = summarizeMessagePart(part);
        if (text) content.push({ type: 'text', text });
      }
    }
    if (content.length) prompt.push({ role: 'assistant', content });
    if (toolResults.length) prompt.push({ role: 'tool', content: toolResults });
  }
  return prompt;
}

function wrapUntrustedToolResult(text: string): string {
  const escaped = text
    .replace(/<function\s*=/gi, '&lt;function=')
    .replace(/<\|([^|]+)\|>/g, '‹|$1|›')
    .replace(/<tool_call>/gi, '&lt;tool_call&gt;')
    .replace(/\[\[?tool_call\]?\]/gi, '［［tool_call］］')
    .replace(/\btool_call\s*:/gi, 'tool_call：')
    .replace(/`{3,}/g, (fence) => 'ˋ'.repeat(fence.length));
  return `--- BEGIN UNTRUSTED TOOL RESULT ---\n${escaped}\n--- END UNTRUSTED TOOL RESULT ---`;
}

function collectUntrustedPromptText(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (message.role === 'user' && part.type === 'text') return [part.text];
      if (part.type === 'tool_call' && part.output) return [part.output.text];
      return [];
    }),
  );
}

function isGemini3Model(model: ModelInfo | undefined): boolean {
  return (
    model?.providerId === 'gemini' && /gemini[-/]3(?:[.-]|$)/i.test(`${model.ref} ${model.name}`)
  );
}

function compactConversationMessages(
  messages: readonly Message[],
  contextWindow: number,
  estimate: (text: string) => number,
  blobStore: InMemoryBlobStore,
  sessionId: string,
): {
  messages: Message[];
  summary: string;
  events: {
    kind: string;
    beforeTokens: number;
    afterTokens: number;
    recoveryHandle: string | null;
  }[];
} {
  const seenReads = new Map<string, string>();
  const events: {
    kind: string;
    beforeTokens: number;
    afterTokens: number;
    recoveryHandle: string | null;
  }[] = [];
  const hygienic = messages.map((message, messageIndex) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== 'tool_call' || !part.output) return part;
      const isStale = messageIndex < messages.length - 10;
      const isPayload = /^\s*(?:\{|\[|<!doctype html|<html)/i.test(part.output.text);
      if (isStale && estimate(part.output.text) > 240 && !isPayload) {
        const handle = part.output.recoveryHandle ?? blobStore.put(sessionId, part.output.text);
        const text = summarizeStaleToolResult(part.output.text, handle);
        events.push({
          kind: 'context-hygiene',
          beforeTokens: estimate(part.output.text),
          afterTokens: estimate(text),
          recoveryHandle: handle,
        });
        return {
          ...part,
          output: {
            ...part.output,
            text,
            filtered: true,
            originalTokens: estimate(part.output.text),
            filteredTokens: estimate(text),
            recoveryHandle: handle,
          },
        };
      }
      if (part.tool !== 'read_file') return part;
      const path = typeof part.args.path === 'string' ? part.args.path : '';
      const previous = seenReads.get(path);
      seenReads.set(path, part.output.text);
      if (!path || previous !== part.output.text) return part;
      const handle = part.output.recoveryHandle ?? blobStore.put(sessionId, part.output.text);
      const text = `[${path} unchanged since its earlier read. Full output: ${handle}]`;
      events.push({
        kind: 'context-hygiene',
        beforeTokens: estimate(part.output.text),
        afterTokens: estimate(text),
        recoveryHandle: handle,
      });
      return {
        ...part,
        output: {
          ...part.output,
          text,
          filtered: true,
          originalTokens: estimate(part.output.text),
          filteredTokens: estimate(text),
          recoveryHandle: handle,
        },
      };
    }),
  }));
  const hygieneInput = hygienic.flatMap((message, messageIndex) =>
    message.parts.flatMap((part) => {
      if (part.type !== 'tool_call' || !part.output) return [];
      const text = part.output.text;
      const kind = text.startsWith('Older tool result summary:')
        ? 'context-summary'
        : part.tool === 'read_file'
          ? 'file-read'
          : /^\s*(?:\{|\[)/.test(text)
            ? 'json'
            : /^\s*<!doctype html|^\s*<html/i.test(text)
              ? 'html'
              : 'tool-result';
      return [
        {
          key: `${message.id}:${part.id}`,
          role: message.role,
          content: text,
          kind,
          step: messageIndex + 1,
          ...(part.tool === 'read_file'
            ? { path: typeof part.args.path === 'string' ? part.args.path : '' }
            : {}),
          ...(part.output.recoveryHandle ? { handle: part.output.recoveryHandle } : {}),
        },
      ];
    }),
  );
  const hygieneResult = optimizeContextMessages(hygieneInput, {
    currentStep: messages.length,
    staleAfterSteps: 10,
    blobStore,
    sessionId,
  });
  if (hygieneResult.event.afterTokens < hygieneResult.event.beforeTokens)
    events.push({
      kind: 'context-hygiene',
      beforeTokens: hygieneResult.event.beforeTokens,
      afterTokens: hygieneResult.event.afterTokens,
      recoveryHandle: null,
    });
  const hygieneByKey = new Map(hygieneResult.output.map((entry) => [entry.key, entry]));
  const compressed = hygienic.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== 'tool_call' || !part.output) return part;
      const updated = hygieneByKey.get(`${message.id}:${part.id}`);
      if (!updated || updated.content === part.output.text) return part;
      return {
        ...part,
        output: {
          ...part.output,
          text: updated.content,
          filtered: true,
          originalTokens: estimate(part.output.text),
          filteredTokens: estimate(updated.content),
          recoveryHandle: updated.handle ?? part.output.recoveryHandle,
        },
      };
    }),
  }));
  const outputs: {
    key: string;
    role: string;
    content: string;
    toolOutput: true;
    protected: boolean;
    recoveryHandle?: string;
  }[] = [];
  for (const [messageIndex, message] of compressed.entries())
    for (const part of message.parts)
      if (part.type === 'tool_call' && part.output)
        outputs.push({
          key: `${message.id}:${part.id}`,
          role: message.role,
          content: part.output.text,
          toolOutput: true,
          protected: messageIndex >= messages.length - 8,
          ...(part.output.recoveryHandle ? { recoveryHandle: part.output.recoveryHandle } : {}),
        });
  if (!outputs.length) return { messages: compressed, summary: '', events };
  const compacted = compactContext(outputs, contextWindow, estimate, {
    threshold: 0.9,
    protectedTail: 4,
    maxToolLines: 2000,
    maxToolBytes: 10_000,
  });
  const replacements = new Map(compacted.messages.map((entry) => [entry.key, entry.content]));
  const beforeTokens = outputs.reduce((sum, output) => sum + estimate(output.content), 0);
  const afterTokens = compacted.messages.reduce((sum, output) => sum + estimate(output.content), 0);
  if (afterTokens < beforeTokens)
    events.push({ kind: 'context-compaction', beforeTokens, afterTokens, recoveryHandle: null });
  return {
    events,
    messages: compressed.map((message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.type === 'tool_call' && part.output && replacements.has(`${message.id}:${part.id}`)
          ? {
              ...part,
              output: {
                ...part.output,
                text: replacements.get(`${message.id}:${part.id}`) ?? part.output.text,
              },
            }
          : part,
      ),
    })),
    summary: compacted.pruned
      ? `Context compacted: ${String(compacted.pruned)} older tool output(s) were pruned; recovery handles remain available.`
      : '',
  };
}

function hasForeignUnsignedToolHistory(
  messages: readonly Message[],
  targetProviderId: string,
): boolean {
  return messages.some((message) => {
    if (message.role !== 'assistant') return false;
    const sourceProvider = message.modelRef?.split('/', 1)[0];
    if (!sourceProvider || sourceProvider === targetProviderId) return false;
    return message.parts.some(
      (part) => part.type === 'tool_call' && !hasThoughtSignature(part.providerOptions),
    );
  });
}

function hasThoughtSignature(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): boolean {
  return Object.values(providerOptions ?? {}).some(
    (options) =>
      typeof options.thoughtSignature === 'string' && options.thoughtSignature.length > 0,
  );
}

function withGemini3ThoughtSignature(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
  targetModel: ModelInfo | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!isGemini3Model(targetModel) || hasThoughtSignature(providerOptions)) return providerOptions;
  return {
    ...providerOptions,
    google: {
      ...providerOptions?.google,
      thoughtSignature: 'skip_thought_signature_validator',
    },
  };
}

function compactToolHistoryText(text: string): string {
  const limit = 1_600;
  if (text.length <= limit) return text;
  return `${text.slice(0, 1_250)}\n[Earlier tool output shortened; inspect again if needed.]\n${text.slice(-250)}`;
}

function summarizeStaleToolResult(text: string, handle: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const diagnostics = lines.filter((line) =>
    /(?:\berror\b|\bwarning\b|\bfailed\b|\bFAIL(?:ED)?\b|AssertionError|Traceback|(?:^|\s)[\w./-]+\.(?:tsx?|jsx?|py|rs)(?::\d+)?)/i.test(
      line,
    ),
  );
  const retained = [...new Set([lines[0] ?? '(empty output)', ...diagnostics])].slice(0, 12);
  return `Older tool result summary:\n${retained.join('\n')}\n[recover ${handle}]`;
}

function rootErrorCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && current.cause !== undefined && !seen.has(current.cause)) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

function summarizeMessagePart(part: MessagePart): string {
  if (part.type === 'handoff_marker') return `Model handoff: ${part.explanation}`;
  if (part.type === 'approval_request') return `Approval ${part.state}: ${part.summary}`;
  if (part.type === 'error') return `Error (${part.kind}): ${part.message}`;
  if (part.type === 'checkpoint') return `Checkpoint created: ${part.label}`;
  if (part.type === 'delegation') return `Delegation ${part.runId}`;
  return '';
}

class StepWatchdogError extends Error {
  constructor(timeoutMs: number) {
    super(`Model step stalled without stream progress for ${String(timeoutMs)}ms`);
    this.name = 'StepWatchdogError';
  }
}

async function runWithStepWatchdog(
  generator: StepGenerator,
  makeRequest: (
    model: ModelInfo,
    signal: AbortSignal,
    onProgress: () => void,
  ) => StepGeneratorInput,
  model: ModelInfo,
  parentSignal: AbortSignal,
  timeoutMs: number,
  onAbort: () => void = () => undefined,
): Promise<GeneratedStep> {
  if (parentSignal.aborted)
    throw parentSignal.reason instanceof Error
      ? parentSignal.reason
      : new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const abort = () => {
    const reason =
      parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new DOMException('Aborted', 'AbortError');
    controller.abort(reason);
    onAbort();
    rejectTimeout(reason);
  };
  parentSignal.addEventListener('abort', abort, { once: true });
  const resetWatchdog = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new StepWatchdogError(timeoutMs);
      controller.abort(error);
      onAbort();
      rejectTimeout(error);
    }, timeoutMs);
  };
  resetWatchdog();
  try {
    return await Promise.race([
      generator(makeRequest(model, controller.signal, resetWatchdog)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener('abort', abort);
  }
}

function errorInput(error: unknown): Parameters<typeof classifyProviderError>[0] {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const outer = error as Record<string, unknown>;
  const candidate = (
    outer.name === 'AI_StreamProviderError' && outer.cause && typeof outer.cause === 'object'
      ? outer.cause
      : outer
  ) as Record<string, unknown> & {
    response?: { status?: unknown; headers?: Headers };
    data?: { error?: { code?: unknown; type?: unknown; message?: unknown } };
  };
  const headers = candidate.response?.headers;
  return {
    status: candidate.status,
    statusCode: candidate.statusCode ?? candidate.response?.status,
    code: candidate.code ?? candidate.data?.error?.code,
    type: candidate.type ?? candidate.data?.error?.type,
    message: candidate.data?.error?.message ?? candidate.message,
    responseBody: candidate.data ? JSON.stringify(candidate.data) : candidate.responseBody,
    ...(headers ? { headers } : {}),
    retryAfter: candidate.retryAfter,
  };
}

async function delayForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error('Aborted', { cause: reason }));
      },
      { once: true },
    );
  });
}

function errorStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  return Number(candidate.statusCode ?? candidate.status ?? candidate.response?.status ?? 0);
}

function providerErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return 'Provider request failed';
  const candidate = error as {
    message?: unknown;
    responseBody?: unknown;
    data?: { error?: { message?: unknown } };
  };
  if (typeof candidate.data?.error?.message === 'string') return candidate.data.error.message;
  if (typeof candidate.responseBody === 'string') {
    try {
      const body: unknown = JSON.parse(candidate.responseBody);
      if (
        body &&
        typeof body === 'object' &&
        'error' in body &&
        body.error &&
        typeof body.error === 'object' &&
        'message' in body.error &&
        typeof body.error.message === 'string'
      )
        return body.error.message;
    } catch {
      // Use the provider error's short message when the response is not JSON.
    }
  }
  return typeof candidate.message === 'string' ? candidate.message : 'Provider request failed';
}

function formatToolCapabilityFailure(model: ModelInfo, error: unknown): string {
  const status = errorStatus(error) || 400;
  const message = redactedProviderMessage(error);
  return `${model.ref}: HTTP ${String(status)} — ${message}`;
}

function formatClassifiedFailure(family: string, error: unknown): string {
  const status = errorStatus(error);
  return `${family}${status ? ` (HTTP ${String(status)})` : ''}: ${redactedProviderMessage(error)}`;
}

function formatAttemptSummary(attempts: readonly AttemptFailure[], fallback: string): string {
  if (!attempts.length) return `Couldn't finish this step: ${shortFailureSummary(fallback)}`;
  const models = new Set(attempts.map((attempt) => attempt.model));
  const reasons = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.kind === 'rate_limit') reasons.add('rate limits');
    else if (attempt.kind === 'quota_exhausted') reasons.add('quota limits');
    else if (attempt.kind === 'request_too_large') {
      const provider = attempt.model.split('/')[0] ?? 'provider';
      reasons.add(`request too large for ${provider}`);
    } else if (attempt.kind === 'request_scoped_client') reasons.add('request errors');
    else if (attempt.kind === 'model_not_found') reasons.add('unavailable models');
    else if (attempt.kind === 'timeout') reasons.add('timeouts');
    else if (attempt.kind === 'auth') reasons.add('authentication errors');
    else if (attempt.kind === 'server') reasons.add('provider errors');
    else reasons.add(attempt.kind.replaceAll('_', ' '));
  }
  const count = models.size;
  return `Couldn't finish this step: ${count === 1 ? 'the selected model failed' : `all ${String(count)} models failed`} (${[...reasons].join(', ')}).`;
}

function shortFailureSummary(value: string): string {
  return (
    value
      .split(/Ranked candidates:|scoreBreakdown/i, 1)[0]
      ?.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220) ?? 'No eligible model could handle this request.'
  );
}

function redactedProviderMessage(error: unknown): string {
  return providerErrorMessage(error)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|or|AIza)[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,
      '$1[redacted]',
    )
    .slice(0, 240);
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
function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
