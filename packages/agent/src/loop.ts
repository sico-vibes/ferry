import {
  jsonSchema,
  streamText,
  tool,
  type JSONSchema7,
  type ModelMessage,
  type ProviderMetadata,
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
  reasoningTransportOptions,
  normalizeToolSchema,
} from '@ferry/providers';
import {
  optimizeOutput,
  InMemoryBlobStore,
  readOutput,
  compactContext,
  optimizeContextMessages,
  estimateTokens as estimateOptimizerTokens,
  compressCavemanMessages,
  type CavemanInputCache,
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
import { evaluateProactiveQuota } from '@ferry/quota';
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
  type TraceContext,
  type TelemetrySink,
  newTraceId,
  newSpanId,
  normalizeInlineThinking,
  normalizeReasoningPart,
  reasoningTokensFromUsage,
  type Effort,
  type RunReport,
  type RunCompleted,
  extractRequirements,
  taskGoal,
  pendingRequirements,
  modelAcceptsImages,
} from '@ferry/shared';
import { snapshotRunFiles, changedRunFiles } from './run-files.js';
import { serializeMessagesForEstimate } from './message-estimate.js';
import { retryDelayFromHeaders, quotaPeriodMs } from './routing-limits.js';
import type { Catalog } from '@ferry/catalog';
import type { RawCallObservation } from '@ferry/providers';
import {
  assembleSystemPrompt,
  loadPromptEnvironment,
  withModelIdentity,
  type PromptSection,
} from './prompt.js';
import { SessionStore } from './session.js';
import {
  createWorkspaceTools,
  ToolPermissionDeniedError,
  type AgentTool,
  type ToolSource,
} from './tool-registry.js';
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
  | ({ type: 'run.completed' } & RunCompleted)
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
      runId?: string;
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
  reasoningProviderMetadata?: ProviderMetadata;
  reasoningAvailable?: boolean;
  reasoningTokens?: number;
  thinkingDurationMs?: number;
  toolCalls?: ModelToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  responseModel?: string;
}
export interface StepGeneratorInput {
  requestId?: string;
  model: ModelInfo;
  effort?: Effort | null | undefined;
  system: string;
  messages: readonly Message[];
  tools: readonly AgentTool[];
  signal: AbortSignal;
  onProgress?: () => void;
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolDelta?: () => void;
  modelHints: ModelHints;
  /** "required": the model must call a tool this step (used for requirement verification). */
  toolChoice?: 'auto' | 'required';
}
export type StepGenerator = (input: StepGeneratorInput) => Promise<GeneratedStep>;

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
  recent?: boolean;
  dataDir: string;
  profile: Profile;
  catalog: Catalog;
  capacity(): CapacityView;
  apiKeys: Readonly<Record<string, string>>;
  permissionMode: import('@ferry/shared').PermissionMode;
  permissionRules?: import('@ferry/workspace').PermissionRule[];
  emit(event: AgentEvent): void;
  traceContext?: TraceContext;
  telemetry?: TelemetrySink;
  onCheckpointCreated?: (checkpointId: string, label: string) => void;
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
  providerHeaders?: Readonly<Record<string, Record<string, string>>>;
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
  /** Read the user's current pin at step boundaries; when provided it supersedes the snapshot. */
  getPinnedModelRef?: () => ModelRef | null;
  tokenBudget?: number;
  /** Maximum time without stream progress before this model attempt is abandoned. */
  stepTimeoutMs?: number;
  firstTokenTimeoutSeconds?: number;
  /** Wall time spent on failed requests and their retries, excluding quota pacing. */
  routingDeadlineSeconds?: number;
  waitForRetry?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  pinnedTurns?: number;
  estimateTokens?: (text: string) => number;
  isProviderEnabled?: (providerId: string) => boolean;
  onObservation?: (observation: RawCallObservation) => void;
  onUsage?: (usage: UsageRecord) => void;
  onProviderAttempt?: (attempt: {
    error?: unknown;
    requestId: string;
    sessionId: string;
    modelRef: string;
    providerId: string;
    keyId: string | null;
    success: boolean;
    family: string | null;
    statusCode: number | null;
    message: string;
  }) => void;
  authorizePaidCall?: (
    model: ModelInfo,
    estimate: { inputTokens: number; outputTokens: number },
    signal: AbortSignal,
  ) => Promise<{ allowed: boolean; message?: string; usageId?: string; release?: () => void }>;
  onHandoff?: (
    reason: 'quota' | 'rate_limit' | 'error' | 'capability' | 'manual',
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
  /** Configured key ids in the same namespace returned by providerAffinityKey. */
  providerKeyIds?: (providerId: string) => readonly string[];
  providerUnavailableKeyIds?: (providerId: string, modelRef?: string) => readonly string[];
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
  id?: string;
  attempt?: number;
  providerKeyId?: string;
  outputStarted?: boolean;
  fallbackReason?: string;
  kind: ProviderFailureFamily;
  status: number | null;
  latencyMs: number;
  message: string;
}

interface ModelAttempt {
  model: ModelRef;
  provider: string;
  id?: string;
  attempt?: number;
  providerKeyId?: string;
  outputStarted?: boolean;
  fallbackReason?: string;
  upstreamModel?: string;
  responseModel?: string;
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
  warnings?: string[];
  report?: RunReport | undefined;
  /** User messages the model saw in its last step; any later ones still need an answer. */
  seenUserMessageIds?: string[];
}

export class AgentLoop {
  private readonly runReports = new Map<
    string,
    {
      startedAt: number;
      report: RunReport;
      mutation: boolean;
      permissionDenied: boolean;
      lastStep: string;
      waitMs: number;
    }
  >();
  private readonly estimates: (text: string) => number;
  private readonly recoveryStore = new InMemoryBlobStore();
  private readonly cavemanCache: CavemanInputCache = new Map();
  private readonly resilience: ResilienceLedger;
  private readonly sessionModelLocks = new Map<string, Set<string>>();
  private readonly requestTooLargeAt = new Map<ModelRef, number>();
  private readonly sticky: StickySessionLedger;
  private readonly reliability: ReliabilityObservation[];
  private readonly toolRejections: ToolRejection[];
  private readonly retirementFailures: RetirementFailure[];
  private readonly retiredModels: Set<string>;
  private readonly softQuotaBypasses = new Map<string, Set<string>>();
  private readonly proactiveHandoverSteps = new Map<string, number>();
  /** User messages included in each session's most recent step, for mid-turn messages. */
  private readonly contextUserIds = new Map<string, Set<string>>();
  private readonly sessionBadKeys = new Map<string, Set<string>>();
  private readonly pinnedHandoverModels = new Map<string, ModelRef>();
  private readonly pinnedHandoverSourcePins = new Map<string, ModelRef>();
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

  private providerKeysExhausted(sessionId: string, providerId: string, modelRef?: string): boolean {
    const badKeys = this.sessionBadKeys.get(sessionId) ?? new Set<string>();
    if (badKeys.has(`${providerId}:*`)) return true;
    const keyIds = this.options.providerKeyIds?.(providerId) ?? [];
    const unavailable = this.options.providerUnavailableKeyIds?.(providerId, modelRef) ?? [];
    const effectivelyBad = new Set([
      ...[...badKeys].filter((key) => key.startsWith(`${providerId}:`)),
      ...unavailable.map((keyId) => `${providerId}:${keyId}`),
    ]);
    return (
      keyIds.length > 0 && keyIds.every((keyId) => effectivelyBad.has(`${providerId}:${keyId}`))
    );
  }

  private pinnedModelRefFor(sessionId: string): ModelRef | null {
    if (this.options.getPinnedModelRef) {
      const livePin = this.options.getPinnedModelRef();
      if (!livePin) {
        this.pinnedHandoverModels.delete(sessionId);
        this.pinnedHandoverSourcePins.delete(sessionId);
        return null;
      }
      if (this.pinnedHandoverSourcePins.get(sessionId) !== livePin) {
        this.pinnedHandoverModels.delete(sessionId);
        this.pinnedHandoverSourcePins.delete(sessionId);
      }
      return this.pinnedHandoverModels.get(sessionId) ?? livePin;
    }
    return this.pinnedHandoverModels.get(sessionId) ?? this.options.pinnedModelRef ?? null;
  }

  private emitStructuredEvent(sessionId: string, event: StructuredAgentEvent): void {
    this.options.store.appendAgentEvent(sessionId, event);
    this.options.emit({ type: 'agent.event', sessionId, event });
  }

  async run({ sessionId, signal: outerSignal, resume = false }: RunInput): Promise<RunResult> {
    const cavemanRunId = newId('run');
    const traceContext = this.options.traceContext ?? { traceId: newTraceId() };
    const traceId = traceContext.traceId;
    let requestGroupId: string;
    let parentTurnId: string | null;
    let attemptNumber: number;
    this.options.telemetry?.log({
      id: newId('evt'),
      ts: new Date().toISOString(),
      level: 'info',
      source: 'agent',
      event: 'request.received',
      session_id: sessionId,
      trace_id: traceId,
      data: {},
    });
    if (this.options.routingSettings?.().cooldownReasons)
      void this.options.probeHeuristicCooldowns?.().catch(() => undefined);
    const controller = new AbortController();
    const relayAbort = () => {
      controller.abort(outerSignal?.reason);
    };
    outerSignal?.addEventListener('abort', relayAbort, { once: true });
    if (outerSignal?.aborted) relayAbort();
    const signal = controller.signal;
    const environment = this.options.recent
      ? { branch: null, status: null, instructions: null }
      : await loadPromptEnvironment(this.options.workspace);
    let loaded = this.options.store.load(sessionId);
    if (!loaded) throw new Error(`Unknown session ${sessionId}`);
    this.sessionBadKeys.set(sessionId, new Set());
    this.softQuotaBypasses.set(sessionId, new Set());
    this.proactiveHandoverSteps.delete(sessionId);
    let { session, messages, taskRecord } = loaded;
    const firstRequest = messages
      .find((message) => message.role === 'user')
      ?.parts.find((part) => part.type === 'text')?.text;
    if (firstRequest) {
      const requirements = extractRequirements(firstRequest);
      taskRecord = {
        ...taskRecord,
        goal: taskGoal(firstRequest),
        plan: taskRecord.plan.some((item) => item.id.startsWith('requirement_'))
          ? taskRecord.plan
          : [...requirements, ...taskRecord.plan],
      };
      this.persistTask(taskRecord);
    }
    let verificationRounds = 0;
    let verificationNote: string | undefined;
    this.runReports.set(sessionId, {
      startedAt: this.now(),
      mutation: false,
      permissionDenied: false,
      lastStep: 'Final check',
      waitMs: 0,
      report: {
        durationMs: 0,
        steps: 0,
        ownerModel: null,
        modelsUsed: [],
        switches: [],
        waits: [],
        failedAttempts: [],
        tokens: { input: 0, output: 0, reasoning: 0 },
        filesChanged: [],
        outcome: 'completed',
        warnings: [],
      },
    });
    this.options.store.updateSession(sessionId, {
      ownerModelRef: null,
      runReport: undefined,
    });
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
    let routingFailurePending = false;
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
      onCheckpointCreated: (checkpointId, label) => {
        this.options.onCheckpointCreated?.(checkpointId, label);
        this.options.telemetry?.log({
          id: newId('evt'),
          ts: new Date().toISOString(),
          level: 'info',
          source: 'agent',
          event: 'checkpoint.created',
          session_id: sessionId,
          trace_id: traceId,
          data: { checkpoint_id: checkpointId, label },
        });
      },
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
        const runState = this.runReports.get(sessionId);
        if (!runState) throw new Error('Run report state disappeared');
        runState.waitMs = 0;
        requestGroupId = newId('group');
        parentTurnId = null;
        attemptNumber = 0;
        if (signal.aborted)
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'cancelled');
        loaded = this.options.store.load(sessionId);
        if (!loaded) throw new Error('Session disappeared during run');
        session = loaded.session;
        messages = loaded.messages.filter((message) => !rejectedPlannerMessageIds.has(message.id));
        this.contextUserIds.set(
          sessionId,
          new Set(
            messages.filter((message) => message.role === 'user').map((message) => message.id),
          ),
        );
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
        attemptFailures.length = 0;
        const keepTurns = this.options.pinnedTurns ?? 4;
        const pinnedMessages = messages.slice(-keepTurns * 2);
        if (messages.length > pinnedMessages.length) {
          const omitted = `${String(messages.length - pinnedMessages.length)} older conversation message(s) omitted by the recent-turn window; tool outputs remain recoverable from their handles.`;
          taskRecord = {
            ...taskRecord,
            decisions: [
              ...taskRecord.decisions.filter(
                (decision) => decision.why !== 'Recent context omitted.',
              ),
              { text: omitted, why: 'Recent context omitted.', at: new Date().toISOString() },
            ].slice(-12),
          };
          this.persistTask(taskRecord);
        }
        let system = await assembleSystemPrompt({
          recent: this.options.recent ?? false,
          environment,
          workspace: this.options.workspace,
          sessionId,
          task: taskRecord,
          terseLevel: this.options.terseLevel ?? this.options.profile.optimizers.terse,
          ...(this.options.promptSections ? { sections: this.options.promptSections } : {}),
        });
        // A verification round must use tools (check, read, update_plan), not restate the summary.
        const verifying = Boolean(verificationNote);
        if (verificationNote) {
          system += `\n\n${verificationNote}`;
          verificationNote = undefined;
        }
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
          serializeMessagesForEstimate(
            toModelMessages(pinnedMessages, this.options.catalog.models[0]),
          ),
        );
        const inputTokens = Math.ceil(
          (this.estimates(system) + messageTokens + toolSchemaTokens) * 1.15,
        );
        const minimumContext = Math.min(
          Math.ceil(
            (this.estimates(system) +
              toolSchemaTokens +
              this.estimates(JSON.stringify(messages.slice(-2)))) *
              1.15,
          ),
          this.contextFitEstimate(inputTokens),
        );
        const estimatedInputTokens = inputTokens;
        this.restoreOwnerEligibility(sessionId, inputTokens);
        const stepKind = plannerRepairHint
          ? 'plan'
          : pendingEditPlan
            ? 'edit'
            : classifyStep({
                firstStep: stepCount === 0,
                pendingEdits: taskRecord.touchedFiles.length > 0,
                estimatedInputTokens,
              });
        runState.lastStep =
          taskRecord.nextStep ??
          taskRecord.plan.find((item) => item.status === 'doing')?.text ??
          `${stepKind} step`;
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
              estimatedInputTokens,
              session.modelRef,
              sessionId,
              minimumContext,
            )
          : this.selectModel(
              stepKind,
              estimatedInputTokens,
              session.modelRef,
              sessionId,
              minimumContext,
            );
        if (requestedRole === 'planner' && selectedModel) {
          const editor = this.selectRoleModel(
            'editor',
            'edit',
            estimatedInputTokens,
            selectedModel.ref,
            sessionId,
            minimumContext,
          );
          if (!editor || editor.ref === selectedModel.ref) {
            rolesEnabled = false;
            requestedRole = undefined;
            selectedModel = this.selectModel(
              stepKind,
              estimatedInputTokens,
              session.modelRef,
              sessionId,
              minimumContext,
            );
          }
        }
        // Why routing moved off the model it would otherwise use this step, if it did.
        let routeSwitchReason: 'quota' | undefined;
        if (selectedModel) {
          const quotaProvider = this.options
            .capacity()
            .providers.find((provider) => provider.id === selectedModel?.providerId);
          let quotaSignal = evaluateProactiveQuota({
            windows: (quotaProvider?.windows ?? []).filter(
              (window) => window.scope === 'provider' || window.modelRef === selectedModel?.ref,
            ),
            stepsLeft: quotaProvider?.stepsLeftToday ?? null,
            inputTokens: estimatedInputTokens,
            outputTokens: 2048,
            now: this.now(),
          });
          const cooldownActive = Boolean(
            quotaProvider?.health === 'cooldown' &&
            quotaProvider.cooldownUntil &&
            Date.parse(quotaProvider.cooldownUntil) > this.now(),
          );
          if (cooldownActive) quotaSignal.signal = 'hard';
          if (quotaSignal.signal === 'hard') {
            const hardWindow = quotaProvider?.windows.find(
              (window) => window.id === quotaSignal.windowId,
            );
            const resetAt = quotaSignal.resetAt ?? quotaProvider?.cooldownUntil;
            if (
              (!cooldownActive || quotaProvider?.cooldownProvenance === 'authoritative') &&
              (await this.paceLimit(
                sessionId,
                selectedModel,
                resetAt ? Date.parse(resetAt) - this.now() : null,
                quotaPeriodMs(hardWindow),
                signal,
              ))
            ) {
              const refreshed = this.options
                .capacity()
                .providers.find((provider) => provider.id === selectedModel?.providerId);
              quotaSignal = evaluateProactiveQuota({
                windows: (refreshed?.windows ?? []).filter(
                  (window) => window.scope === 'provider' || window.modelRef === selectedModel?.ref,
                ),
                stepsLeft: refreshed?.stepsLeftToday ?? null,
                inputTokens: estimatedInputTokens,
                outputTokens: 2048,
                now: this.now(),
              });
            }
          }
          const pinned = Boolean(this.pinnedModelRefFor(sessionId));
          const lastHandover = this.proactiveHandoverSteps.get(sessionId) ?? -Infinity;
          const maySoftHandover = !pinned && stepCount - lastHandover >= 3;
          if (quotaSignal.signal === 'soft' && !pinned && maySoftHandover) {
            this.softQuotaBypasses.get(sessionId)?.add(selectedModel.ref);
            const previous = selectedModel;
            const rerouted = this.selectModel(
              stepKind,
              estimatedInputTokens,
              session.modelRef,
              sessionId,
              minimumContext,
            );
            const owner =
              this.options.catalog.models.find(
                (candidate) => candidate.ref === runState.report.ownerModel,
              ) ?? previous;
            if (
              rerouted &&
              rerouted.ref !== previous.ref &&
              this.isAtLeastOwner(rerouted, owner, stepKind, estimatedInputTokens)
            ) {
              selectedModel = rerouted;
              routeSwitchReason = 'quota';
              this.proactiveHandoverSteps.set(sessionId, stepCount);
              this.options.telemetry?.log({
                id: newId('evt'),
                ts: new Date().toISOString(),
                level: 'info',
                source: 'router',
                event: 'routing.decision',
                session_id: sessionId,
                trace_id: traceId,
                data: {
                  signal: 'soft',
                  excluded_model: previous.ref,
                  selected_model: rerouted.ref,
                  steps_left: quotaProvider?.stepsLeftToday ?? null,
                },
              });
            } else {
              this.softQuotaBypasses.get(sessionId)?.delete(previous.ref);
            }
          } else if (quotaSignal.signal === 'hard') {
            if (pinned) {
              const pin = this.pinnedModelRefFor(sessionId);
              const pinnedExhaustion =
                this.options.routingSettings?.().pinnedExhaustion ?? 'handover';
              let approved = pinnedExhaustion === 'handover';
              if (pinnedExhaustion === 'ask' && this.options.requestApproval) {
                const approval: Extract<MessagePart, { type: 'approval_request' }> = {
                  type: 'approval_request',
                  id: PartIdSchema.parse(newId('part')),
                  kind: 'model_handover',
                  summary: `Switch from ${selectedModel.name} because its quota is nearly exhausted?`,
                  detail: 'Ferry will continue this step with another eligible model.',
                  risk: 'medium',
                  state: 'pending',
                };
                this.addPart(sessionId, approval);
                const waiting = this.options.store.updateSession(sessionId, {
                  status: 'awaiting_approval',
                });
                this.options.emit({ type: 'session.updated', session: waiting });
                const decision = await this.options.requestApproval(approval, signal);
                const resumed = this.options.store.updateSession(sessionId, { status: 'running' });
                this.options.emit({ type: 'session.updated', session: resumed });
                this.replacePart(sessionId, {
                  ...approval,
                  state: decision === 'denied' ? 'denied' : decision,
                });
                approved = decision === 'allowed_once' || decision === 'allowed_always';
                if (decision === 'denied') runState.permissionDenied = true;
              }
              const fallback =
                approved && pin
                  ? this.selectFallback(
                      stepKind,
                      estimatedInputTokens,
                      new Set([selectedModel.ref]),
                      sessionId,
                      true,
                      minimumContext,
                    )
                  : undefined;
              if (fallback && pin) {
                this.pinnedHandoverSourcePins.set(sessionId, pin);
                this.pinnedHandoverModels.set(sessionId, fallback.ref);
                selectedModel = fallback;
                routeSwitchReason = 'quota';
                this.options.telemetry?.log({
                  id: newId('evt'),
                  ts: new Date().toISOString(),
                  level: 'info',
                  source: 'router',
                  event: 'routing.decision',
                  session_id: sessionId,
                  trace_id: traceId,
                  data: {
                    signal: 'hard',
                    excluded_model: pin,
                    selected_model: fallback.ref,
                    window_id: quotaSignal.windowId,
                    pinned_exhaustion: pinnedExhaustion,
                  },
                });
              } else {
                selectedModel = undefined;
              }
            } else {
              const previous = selectedModel;
              const hardWindow = quotaProvider?.windows.find(
                (window) => window.id === quotaSignal.windowId,
              );
              const excludedRefs =
                cooldownActive || hardWindow?.scope === 'provider'
                  ? this.options.catalog.models
                      .filter((candidate) => candidate.providerId === previous.providerId)
                      .map((candidate) => candidate.ref)
                  : [previous.ref];
              const rerouted = this.selectModel(
                stepKind,
                estimatedInputTokens,
                session.modelRef,
                sessionId,
                minimumContext,
                new Set(excludedRefs),
              );
              if (rerouted && rerouted.ref !== previous.ref) {
                selectedModel = rerouted;
                routeSwitchReason = 'quota';
                this.options.telemetry?.log({
                  id: newId('evt'),
                  ts: new Date().toISOString(),
                  level: 'info',
                  source: 'router',
                  event: 'routing.decision',
                  session_id: sessionId,
                  trace_id: traceId,
                  data: {
                    signal: 'hard',
                    excluded_model: previous.ref,
                    selected_model: rerouted.ref,
                    window_id: quotaSignal.windowId,
                  },
                });
              } else {
                selectedModel = undefined;
              }
            }
          } else if (quotaSignal.signal === 'soft' && pinned) {
            this.options.telemetry?.log({
              id: newId('evt'),
              ts: new Date().toISOString(),
              level: 'info',
              source: 'router',
              event: 'routing.decision',
              session_id: sessionId,
              trace_id: traceId,
              data: {
                signal: 'soft',
                model: selectedModel.ref,
                steps_left: quotaProvider?.stepsLeftToday ?? null,
                reset_at: quotaSignal.resetAt ?? null,
              },
            });
          }
        }
        if (!selectedModel) {
          const pin = this.pinnedModelRefFor(sessionId);
          if (pin)
            throw new AllCandidatesExhaustedError(
              `Pinned model ${pin} is unavailable; no eligible handover model is available (pinnedExhaustion: ${this.options.routingSettings?.().pinnedExhaustion ?? 'handover'}).`,
            );
          throw new AllCandidatesExhaustedError(this.exhaustedMessage(stepKind));
        }
        let model: ModelInfo = selectedModel;
        const targetCompaction = compactConversationMessages(
          messages,
          model.contextWindow,
          this.estimates,
          this.recoveryStore,
          sessionId,
        );
        for (const event of targetCompaction.events)
          this.options.emit({ type: 'optimizer.event', ...event });
        const fittedMessages = targetCompaction.messages.slice(-keepTurns * 2);
        if (targetCompaction.summary) {
          taskRecord = {
            ...taskRecord,
            decisions: [
              ...taskRecord.decisions.filter(
                (decision) => !decision.text.startsWith('Context compacted:'),
              ),
              {
                text: targetCompaction.summary,
                why: 'Keep the compacted context summary in the task record.',
                at: new Date().toISOString(),
              },
            ].slice(-12),
          };
          this.persistTask(taskRecord);
        }
        const omittedNote = targetCompaction.summary
          ? `${targetCompaction.summary} Fitted for ${model.name} (${String(model.contextWindow)} tokens).`
          : '';
        if (omittedNote) {
          taskRecord = {
            ...taskRecord,
            decisions: [
              ...taskRecord.decisions,
              {
                text: omittedNote,
                why: 'Record context omitted during target-model fitting.',
                at: new Date().toISOString(),
              },
            ].slice(-12),
          };
          this.persistTask(taskRecord);
          this.options.telemetry?.log({
            id: newId('evt'),
            ts: new Date().toISOString(),
            level: 'info',
            source: 'router',
            event: 'routing.decision',
            session_id: sessionId,
            data: { target_model: model.ref, omitted_context: omittedNote },
          });
        }
        const targetMessageTokens = this.estimates(
          serializeMessagesForEstimate(toModelMessages(fittedMessages, model)),
        );
        const fittedInputTokens = Math.ceil(
          (this.estimates(system) + targetMessageTokens + toolSchemaTokens) * 1.15,
        );
        let routeEstimate = fittedInputTokens;
        let contextMessages = fittedMessages;
        if (fittedInputTokens > model.contextWindow * 0.9) {
          if (stepCount >= maxSteps)
            return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
          const summaryModel =
            this.selectModel(
              'summarize',
              Math.min(routeEstimate, Math.floor(model.contextWindow * 0.6)),
              session.modelRef,
              sessionId,
              minimumContext,
            ) ?? model;
          const summarize =
            this.options.generator ?? this.createStreamingGenerator(summaryModel, sessionId);
          let summaryResult: GeneratedStep;
          try {
            summaryResult = await runWithStepWatchdog(
              summarize,
              (model, summarySignal, onProgress) => ({
                model,
                system:
                  'Summarize the conversation for continued coding work. Preserve user requirements, completed actions, key discoveries, file names, constraints, and unresolved next steps. Return only the concise summary.',
                messages: fittedMessages,
                tools: [],
                modelHints: this.options.modelHints?.(summaryModel) ?? {
                  toolProtocol: 'native',
                  editFormat: 'search_replace',
                },
                signal: summarySignal,
                onProgress,
                onDelta: () => {
                  onProgress();
                },
              }),
              summaryModel,
              signal,
              this.options.stepTimeoutMs ?? 120_000,
              undefined,
              ['ollama', 'lmstudio'].includes(summaryModel.providerId)
                ? undefined
                : (this.options.firstTokenTimeoutSeconds ??
                    this.options.routingSettings?.().firstTokenTimeoutSeconds ??
                    25) * 1000,
            );
          } catch (error) {
            routingFailurePending = true;
            const classified = classifyProviderError(errorInput(error, this.now()));
            const failure = runState.report.failedAttempts.find(
              (entry) => entry.kind === classified.family,
            );
            if (failure) failure.count++;
            else runState.report.failedAttempts.push({ kind: classified.family, count: 1 });
            attemptFailures.push({
              model: summaryModel.ref,
              provider: summaryModel.providerId,
              kind: classified.family,
              status: classified.status,
              latencyMs: 0,
              message: redactedProviderMessage(error),
            });
            throw error;
          }
          this.recordSuccessfulStep(sessionId, summaryModel, summaryResult, routeEstimate);
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
          contextMessages = fittedMessages;
        }
        const livePinnedRef = this.pinnedModelRefFor(sessionId);
        const previousAssistant = [...messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        if (previousAssistant?.modelRef && previousAssistant.modelRef !== model.ref) {
          runState.report.switches.push({
            from: previousAssistant.modelRef,
            to: model.ref,
            reason:
              routeSwitchReason ??
              (model.ref === runState.report.ownerModel ? 'owner_return' : 'routing'),
            atStep: stepCount + 1,
          });
        }
        if (
          previousAssistant?.modelRef &&
          previousAssistant.modelRef !== model.ref &&
          activeRole === requestedRole
        ) {
          const briefing = buildBriefing(
            taskRecord,
            fittedMessages,
            model,
            Math.floor(model.contextWindow * 0.25),
            this.estimates,
            {
              from: previousAssistant.modelRef,
              to: model.ref,
              reason:
                routeSwitchReason === 'quota'
                  ? 'previous model is near its usage limit'
                  : livePinnedRef
                    ? 'manual model selection'
                    : 'automatic routing boundary',
              ...(omittedNote ? { omittedContext: omittedNote } : {}),
            },
          );
          // A plain step-to-step routing change is a capability choice, not a failure.
          const handoffReason: 'quota' | 'manual' | 'capability' =
            routeSwitchReason ?? (livePinnedRef ? 'manual' : 'capability');
          const marker = createHandoffMarker(
            previousAssistant.modelRef,
            model.ref,
            handoffReason,
            briefing,
            handoffReason === 'quota'
              ? `${model.name} continues because the previous model is near its usage limit.`
              : livePinnedRef
                ? `You selected ${model.name} for the next step.`
                : `Automatic routing selected ${model.name} for the next step.`,
          );
          this.addPart(sessionId, {
            type: 'handoff_marker',
            id: PartIdSchema.parse(newId('part')),
            from: marker.from as ModelRef,
            to: marker.to as ModelRef,
            reason: marker.reason,
            briefingTokens: marker.briefingTokens,
            explanation: marker.explanation,
            trigger: livePinnedRef && !routeSwitchReason ? 'manual' : 'proactive',
          });
          this.options.onHandoff?.(handoffReason, marker.from, marker.to);
          system += `\n\n[Ferry handover packet]\n${briefing.text}`;
          let packetInputTokens = Math.ceil(
            (this.estimates(system) +
              this.estimates(
                serializeMessagesForEstimate(toModelMessages(contextMessages, model)),
              ) +
              toolSchemaTokens) *
              1.15,
          );
          let packetContextOmitted = false;
          let fitCursor = 0;
          while (packetInputTokens > model.contextWindow && fitCursor < contextMessages.length) {
            const oldest = contextMessages[fitCursor];
            if (!oldest) break;
            const compactedOldest = compactMessageToolOutputs(
              oldest,
              this.estimates,
              this.recoveryStore,
              sessionId,
              model.name,
            );
            if (compactedOldest) {
              packetContextOmitted = true;
              contextMessages = contextMessages.map((entry, index) =>
                index === fitCursor ? compactedOldest : entry,
              );
            }
            fitCursor++;
            packetInputTokens = Math.ceil(
              (this.estimates(system) +
                this.estimates(
                  serializeMessagesForEstimate(toModelMessages(contextMessages, model)),
                ) +
                toolSchemaTokens) *
                1.15,
            );
          }
          while (packetInputTokens > model.contextWindow && contextMessages.length > 2) {
            const latestUserIndex = contextMessages.findLastIndex((entry) => entry.role === 'user');
            const removeIndex = latestUserIndex === 0 ? 1 : 0;
            contextMessages = contextMessages.filter((_, index) => index !== removeIndex);
            packetContextOmitted = true;
            packetInputTokens = Math.ceil(
              (this.estimates(system) +
                this.estimates(
                  serializeMessagesForEstimate(toModelMessages(contextMessages, model)),
                ) +
                toolSchemaTokens) *
                1.15,
            );
          }
          if (packetContextOmitted) {
            const omitted = `Older tool outputs or turns were omitted to fit ${model.name}; compacted tool outputs retain recovery handles.`;
            system += `\n\nContext omitted: ${omitted}`;
            taskRecord = {
              ...taskRecord,
              decisions: [
                ...taskRecord.decisions,
                { text: omitted, why: 'Target context fitting.', at: new Date().toISOString() },
              ].slice(-12),
            };
            this.persistTask(taskRecord);
            this.options.telemetry?.log({
              id: newId('evt'),
              ts: new Date().toISOString(),
              level: 'info',
              source: 'router',
              event: 'routing.decision',
              session_id: sessionId,
              data: { target_model: model.ref, omitted_context: omitted },
            });
          }
          if (packetInputTokens > model.contextWindow) {
            const omitted = `Handover packet and recent context fitted to ${model.name}; older context omitted.`;
            system += `\n\nContext omitted: ${omitted}`;
            taskRecord = {
              ...taskRecord,
              decisions: [
                ...taskRecord.decisions,
                { text: omitted, why: 'Target context fitting.', at: new Date().toISOString() },
              ].slice(-12),
            };
            this.persistTask(taskRecord);
          }
          routeEstimate = Math.ceil(
            (this.estimates(system) +
              this.estimates(
                serializeMessagesForEstimate(toModelMessages(contextMessages, model)),
              ) +
              toolSchemaTokens) *
              1.15,
          );
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
        assistant = {
          ...assistant,
          requestedModelRef: this.pinnedModelRefFor(sessionId) ?? 'auto',
        };
        this.options.store.replaceMessage(assistant);
        this.options.emit({ type: 'session.message', message: assistant });
        let streamedTextPartId = PartIdSchema.parse(newId('part'));
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
        let activeTurnId: string | null = null;
        let activeTurnStartedAt = 0;
        let firstTokenRecorded = false;
        const recordFirstToken = () => {
          if (!activeTurnId || firstTokenRecorded) return;
          firstTokenRecorded = true;
          this.options.telemetry?.turnUpdated(activeTurnId, {
            ttft_ms: Math.max(0, Math.round(performance.now() - activeTurnStartedAt)),
          });
          this.options.telemetry?.log({
            id: newId('evt'),
            ts: new Date().toISOString(),
            level: 'info',
            source: 'agent',
            event: 'turn.first_token',
            session_id: sessionId,
            turn_id: activeTurnId,
            trace_id: traceId,
            data: {},
          });
        };
        const cavemanContext = compressCavemanMessages(
          contextMessages,
          this.options.profile.optimizers.cavemanInput,
          this.cavemanCache,
          (context) =>
            estimateOptimizerTokens(serializeMessagesForEstimate(toModelMessages(context, model))),
        );
        contextMessages = cavemanContext.messages;
        if (cavemanContext.event)
          this.options.emit({
            type: 'optimizer.event',
            ...cavemanContext.event,
            runId: cavemanRunId,
          });
        const stepRequest = (
          selected: ModelInfo,
          stepSignal: AbortSignal,
          onProgress: () => void,
        ): StepGeneratorInput => ({
          model: selected,
          requestId: `${routingRequestId}:${String(stepCount)}`,
          effort: this.options.store.load(sessionId)?.session.effort,
          system: withModelIdentity(
            executionRole === 'planner' && stepKind === 'plan'
              ? `${system}\n\nYou are the planner. Do not call tools or edit files. Return only a JSON edit plan matching this shape: {"files":[{"path":"relative/path","intent":"why this file changes"}],"changes":[{"path":"relative/path","instructions":"exact edits or a precise pseudo-diff"}]}. Include every file the editor must change. Paths must be workspace-relative and must not contain parent-directory segments, drive prefixes, or UNC/absolute paths.${plannerRepairHint ? `\n\nRepair required: ${plannerRepairHint}` : ''}`
              : executionRole === 'planner'
                ? `${system}\n\nThe editor failed repeatedly. Apply the structured edit plan directly with your own tool/edit format. Keep the change within the planned files.\n\n${formatEditPlan(pendingEditPlan ?? { files: [], changes: [] })}`
                : executionRole === 'editor' && pendingEditPlan
                  ? `${system}\n\nExecute this approved planner output with your own tool/edit format. Do not expand scope beyond the listed files and instructions.\n\n${formatEditPlan(pendingEditPlan)}`
                  : system,
            selected,
          ),
          messages: contextMessages,
          tools: requestedRole === 'planner' && stepKind === 'plan' ? [] : tools,
          ...(verifying && tools.length ? { toolChoice: 'required' as const } : {}),
          modelHints: this.options.modelHints?.(selected) ?? {
            toolProtocol: 'native',
            editFormat: 'search_replace',
          },
          signal: stepSignal,
          onProgress: () => {
            onProgress();
            recordFirstToken();
          },
          onDelta: (text) => {
            if (isSignalAborted(signal)) return;
            onProgress();
            recordFirstToken();
            endThinking();
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
          onReasoning: (text) => {
            if (!text || isSignalAborted(signal)) return;
            onProgress();
            reasoningStartedAt ??= performance.now();
          },
          onToolDelta: () => {
            onProgress();
            endThinking();
          },
        });
        let reasoningStartedAt: number | undefined;
        let thinkingDurationMs: number | undefined;
        const endThinking = () => {
          if (reasoningStartedAt !== undefined && thinkingDurationMs === undefined)
            thinkingDurationMs = Math.max(0, performance.now() - reasoningStartedAt);
        };
        const stepStartedAt = performance.now();
        let stepDurationMs = 0;
        let generated!: GeneratedStep;
        let generationComplete = false;
        const attemptedModels = new Set<string>([model.ref]);
        const modelAttempts: ModelAttempt[] = [];
        const toolCapabilityFailures: string[] = [];
        let sameModelRetries = 0;
        let handoffsThisStep = 0;
        let pendingPaidRelease: (() => void) | undefined;
        let pendingPaidUsageId: string | undefined;
        let failedAttemptMs = 0;
        const serverModels = new Map<string, Set<string>>();
        const excludedProviders = new Set<string>();
        while (!generationComplete) {
          reasoningStartedAt = undefined;
          thinkingDurationMs = undefined;
          const attemptStartedAt = performance.now();
          const turnId = newId('turn');
          activeTurnId = turnId;
          activeTurnStartedAt = performance.now();
          firstTokenRecorded = false;
          traceContext.turnId = turnId;
          traceContext.spanId = newSpanId();
          attemptNumber++;
          this.options.telemetry?.turnStarted({
            id: turnId,
            session_id: sessionId,
            message_id: assistant.id,
            user_message_id:
              messages.filter((message) => message.role === 'user').at(-1)?.id ?? null,
            trace_id: traceId,
            device_id: traceContext.deviceId,
            request_group_id: requestGroupId,
            attempt: attemptNumber,
            parent_turn_id: parentTurnId,
            source: 'agent',
            step_id: `${sessionId}:${String(stepCount + 1)}`,
            step_kind: stepKind,
            requested_model: this.pinnedModelRefFor(sessionId) ?? 'auto',
            routing_mode: this.pinnedModelRefFor(sessionId) ? 'pinned' : 'auto',
            routed_provider: model.providerId,
            routed_model: model.ref,
            status: 'pending',
            started_at: new Date().toISOString(),
          });
          this.options.telemetry?.log({
            id: newId('evt'),
            ts: new Date().toISOString(),
            level: 'info',
            source: 'agent',
            event: 'turn.requested',
            session_id: sessionId,
            turn_id: turnId,
            trace_id: traceId,
            data: {
              requested_model: this.pinnedModelRefFor(sessionId) ?? 'auto',
              routed_model: model.ref,
            },
          });
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
              ['ollama', 'lmstudio'].includes(model.providerId)
                ? undefined
                : (this.options.firstTokenTimeoutSeconds ??
                    this.options.routingSettings?.().firstTokenTimeoutSeconds ??
                    25) * 1000,
              Math.max(1, (this.options.routingDeadlineSeconds ?? 150) * 1000 - failedAttemptMs),
            );
            endThinking();
            stepDurationMs = Math.max(0, performance.now() - stepStartedAt);
            this.options.telemetry?.turnUpdated(turnId, {
              status: 'success',
              finished_at: new Date().toISOString(),
              latency_ms: Math.round(performance.now() - attemptStartedAt),
              input_tokens: generated.inputTokens ?? null,
              output_tokens: generated.outputTokens ?? null,
              response_model: generated.responseModel ?? null,
              finish_reason: generated.finishReason ?? null,
            });
            this.options.telemetry?.log({
              id: newId('evt'),
              ts: new Date().toISOString(),
              level: 'info',
              source: 'agent',
              event: 'turn.completed',
              session_id: sessionId,
              turn_id: turnId,
              trace_id: traceId,
              data: { response: generated.text ?? '' },
            });
            if (generated.responseModel && generated.responseModel !== model.ref)
              this.options.telemetry?.log({
                id: newId('evt'),
                ts: new Date().toISOString(),
                level: 'warn',
                source: 'agent',
                event: 'turn.model_credit_mismatch',
                session_id: sessionId,
                turn_id: turnId,
                trace_id: traceId,
                data: {
                  routed_model: model.ref,
                  response_model: generated.responseModel,
                },
              });
            parentTurnId = turnId;
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
                ...((generated.thinkingDurationMs ?? thinkingDurationMs) === undefined
                  ? {}
                  : { durationMs: generated.thinkingDurationMs ?? thinkingDurationMs }),
                timestamp: new Date().toISOString(),
              });
            generationComplete = true;
            routingFailurePending = false;
            const attemptProviderKeyId = this.options.providerAffinityKey?.(
              model.providerId,
              sessionId,
            );
            modelAttempts.push({
              model: model.ref,
              provider: model.providerId,
              id: turnId,
              attempt: modelAttempts.length + 1,
              ...(attemptProviderKeyId ? { providerKeyId: attemptProviderKeyId } : {}),
              outputStarted: Boolean(streamedText || generated.text),
              ...(generated.responseModel ? { responseModel: generated.responseModel } : {}),
              status: 200,
              latencyMs: Math.max(0, performance.now() - attemptStartedAt),
              errorKind: null,
            });
            this.options.onProviderAttempt?.({
              requestId: `${routingRequestId}:${String(stepCount)}`,
              sessionId,
              modelRef: model.ref,
              providerId: model.providerId,
              keyId: attemptProviderKeyId ?? null,
              success: true,
              family: null,
              statusCode: 200,
              message: '',
            });
            const successRouting = this.options.routingSettings?.();
            if (successRouting?.smartReliability) {
              this.reliability.push({ modelRef: model.ref, outcome: 'success', at: this.now() });
              this.pruneReliability();
              this.options.onReliabilityState?.([...this.reliability]);
            }
            this.recordSuccessfulStep(sessionId, model, generated, inputTokens);
            if (successRouting?.stickySessions) {
              const ownerModel = runState.report.ownerModel ?? model.ref;
              const ownerProviderId = ownerModel.split('/')[0] ?? model.providerId;
              const providerKeyId = this.options.providerAffinityKey?.(ownerProviderId, sessionId);
              this.sticky.set(
                sessionId,
                ownerModel,
                this.now(),
                successRouting.stickyTtlMinutes * 60_000,
                {
                  providerId: ownerProviderId,
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
            this.resilience.recordSuccess('provider', model.providerId, this.now());
            this.resilience.recordSuccess('key', model.providerId, this.now());
            this.resilience.recordSuccess('model', model.ref, this.now());
            this.options.onResilienceState?.(this.resilience.snapshot());
            break;
          } catch (error) {
            routingFailurePending = true;
            const classified = classifyProviderError(errorInput(error, this.now()));
            const unsafeSignatureError = isInvalidSignatureOrThinkingError(error);
            this.options.telemetry?.turnUpdated(turnId, {
              status: isSignalAborted(signal)
                ? 'cancelled'
                : classified.family === 'timeout'
                  ? 'timeout'
                  : 'error',
              finished_at: new Date().toISOString(),
              latency_ms: Math.round(performance.now() - attemptStartedAt),
              error_kind: classified.family,
              error_message: unsafeSignatureError
                ? 'Provider rejected native reasoning metadata.'
                : redactedProviderMessage(error),
            });
            this.options.telemetry?.log({
              id: newId('evt'),
              ts: new Date().toISOString(),
              level: 'error',
              source: 'agent',
              event: 'turn.failed',
              session_id: sessionId,
              turn_id: turnId,
              trace_id: traceId,
              data: {
                error: unsafeSignatureError
                  ? 'Provider rejected native reasoning metadata.'
                  : error instanceof Error
                    ? error.message
                    : String(error),
              },
            });
            parentTurnId = turnId;
            pendingPaidRelease?.();
            pendingPaidRelease = undefined;
            pendingPaidUsageId = undefined;
            if (executionRole === 'editor') editorFailures += 1;
            const routing = this.options.routingSettings?.();
            const localQuotaReservation = error instanceof QuotaReservationError;
            if (routing?.stickySessions && !runState.report.ownerModel) {
              this.sticky.clear(sessionId);
              this.options.onStickyState?.(this.sticky.snapshot());
            }
            if (routing?.smartReliability && !localQuotaReservation) {
              this.reliability.push({ modelRef: model.ref, outcome: 'failure', at: this.now() });
              this.pruneReliability();
              this.options.onReliabilityState?.([...this.reliability]);
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
            const attemptProviderKeyId = this.options.providerAffinityKey?.(
              model.providerId,
              sessionId,
            );
            attemptFailures.push({
              model: model.ref,
              provider: model.providerId,
              id: turnId,
              attempt: modelAttempts.length + 1,
              ...(attemptProviderKeyId ? { providerKeyId: attemptProviderKeyId } : {}),
              outputStarted: Boolean(streamedText),
              fallbackReason: classified.family,
              kind: classified.family,
              status: classified.status,
              latencyMs: Math.max(0, performance.now() - attemptStartedAt),
              message: unsafeSignatureError
                ? 'Provider rejected native reasoning metadata.'
                : redactedProviderMessage(error),
            });
            modelAttempts.push({
              model: model.ref,
              provider: model.providerId,
              id: turnId,
              attempt: modelAttempts.length + 1,
              ...(attemptProviderKeyId ? { providerKeyId: attemptProviderKeyId } : {}),
              outputStarted: Boolean(streamedText),
              fallbackReason: classified.family,
              status: classified.status,
              latencyMs: Math.max(0, performance.now() - attemptStartedAt),
              errorKind: classified.family,
            });
            failedAttemptMs += Math.max(0, performance.now() - attemptStartedAt);
            const failedKind = runState.report.failedAttempts.find(
              (entry) => entry.kind === classified.family,
            );
            if (failedKind) failedKind.count++;
            else runState.report.failedAttempts.push({ kind: classified.family, count: 1 });
            this.options.onProviderAttempt?.({
              requestId: `${routingRequestId}:${String(stepCount)}`,
              sessionId,
              modelRef: model.ref,
              providerId: model.providerId,
              keyId: attemptProviderKeyId ?? null,
              success: false,
              error,
              family: isSignalAborted(signal)
                ? 'cancelled'
                : localQuotaReservation
                  ? 'local_reservation'
                  : error instanceof StepWatchdogError
                    ? 'timeout'
                    : classified.family,
              statusCode: classified.status,
              message: unsafeSignatureError
                ? 'Provider rejected native reasoning metadata.'
                : redactedProviderMessage(error),
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
            const providerPolicy = this.options
              .capacity()
              .providers.find((item) => item.id === model.providerId);
            const hardQuota = providerPolicy?.windows.find(
              (window) =>
                (window.scope === 'provider' || window.modelRef === model.ref) &&
                window.remaining !== null &&
                window.remaining < (window.metric === 'requests' ? 1 : routeEstimate + 2048),
            );
            if (
              (classified.family === 'rate_limit' || localQuotaReservation) &&
              (await this.paceLimit(
                sessionId,
                model,
                classified.retryAfterMs ??
                  (hardQuota?.resetAt ? Date.parse(hardQuota.resetAt) - this.now() : null),
                /daily|monthly|per.day|per.month/i.test(classified.message)
                  ? 86400_000
                  : quotaPeriodMs(hardQuota),
                signal,
              ))
            )
              continue;
            if (classified.family === 'server') {
              const failures = serverModels.get(model.providerId) ?? new Set<string>();
              failures.add(model.ref);
              serverModels.set(model.providerId, failures);
              if (failures.size >= 2) excludedProviders.add(model.providerId);
            }
            if (
              (hardQuota?.scope === 'provider' && rateLimited) ||
              /circuit.?breaker|breaker.{0,20}open/i.test(classified.message) ||
              (classified.family === 'quota_exhausted' && classified.scope !== 'model')
            )
              excludedProviders.add(model.providerId);
            for (const candidate of this.options.catalog.models)
              if (excludedProviders.has(candidate.providerId)) attemptedModels.add(candidate.ref);
            if (failedAttemptMs >= (this.options.routingDeadlineSeconds ?? 150) * 1000)
              throw new AllCandidatesExhaustedError(
                'Routing deadline reached after failed provider attempts.',
              );
            const stopFallback = shouldStopFallback({
              pinnedModelRef: this.pinnedModelRefFor(sessionId),
              pinnedExhaustion: routing?.pinnedExhaustion ?? 'handover',
              attemptedModelRef: model.ref,
              avoidTrainingProviders: routing?.avoidTrainingProviders ?? false,
              providerDataUse: providerPolicy?.dataUse ?? null,
            });
            const badCredentialStatus =
              [401, 402, 403].includes(classified.status ?? 0) &&
              classified.family !== 'paid_required';
            if (badCredentialStatus) {
              const keyId = this.options.providerAffinityKey?.(model.providerId, sessionId);
              this.sessionBadKeys.get(sessionId)?.add(`${model.providerId}:${keyId ?? '*'}`);
              for (const unavailable of this.options.providerUnavailableKeyIds?.(
                model.providerId,
                model.ref,
              ) ?? [])
                this.sessionBadKeys.get(sessionId)?.add(`${model.providerId}:${unavailable}`);
            }
            if (
              classified.family === 'auth' &&
              this.providerKeysExhausted(sessionId, model.providerId)
            ) {
              excludedProviders.add(model.providerId);
              for (const candidate of this.options.catalog.models)
                if (candidate.providerId === model.providerId) attemptedModels.add(candidate.ref);
            }
            if (!localQuotaReservation && !badCredentialStatus && routingFailure.scope !== 'none') {
              this.resilience.recordFailure(
                routingFailure,
                model.ref,
                model.providerId,
                this.now(),
              );
            }
            let approvedPinnedHandover = false;
            if (
              stopFallback &&
              this.pinnedModelRefFor(sessionId) &&
              routing?.pinnedExhaustion === 'ask' &&
              (rateLimited || badCredentialStatus || timedOut || routingFailure.scope !== 'none') &&
              this.options.requestApproval
            ) {
              const approval: Extract<MessagePart, { type: 'approval_request' }> = {
                type: 'approval_request',
                id: PartIdSchema.parse(newId('part')),
                kind: 'model_handover',
                summary: `Switch from ${model.name} after it became unavailable?`,
                detail: 'Ferry will continue this step with another eligible model.',
                risk: 'medium',
                state: 'pending',
              };
              this.addPart(sessionId, approval);
              const waiting = this.options.store.updateSession(sessionId, {
                status: 'awaiting_approval',
              });
              this.options.emit({ type: 'session.updated', session: waiting });
              const decision = await this.options.requestApproval(approval, signal);
              const resumed = this.options.store.updateSession(sessionId, { status: 'running' });
              this.options.emit({ type: 'session.updated', session: resumed });
              this.replacePart(sessionId, {
                ...approval,
                state: decision === 'denied' ? 'denied' : decision,
              });
              if (decision === 'allowed_once' || decision === 'allowed_always')
                approvedPinnedHandover = true;
              else
                throw new Error(
                  `Pinned model ${model.ref} is unavailable; handover was declined.`,
                  { cause: error },
                );
            }
            if (
              !localQuotaReservation &&
              !badCredentialStatus &&
              !rateLimited &&
              routingFailure.scope !== 'model' &&
              classified.family !== 'request_too_large'
            )
              this.resilience.recordFailure(
                { ...routingFailure, scope: 'model' },
                model.ref,
                model.providerId,
                this.now(),
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
              streamedText.length === 0 &&
              !requestTooLarge &&
              !rateLimited &&
              !badCredentialStatus &&
              retryAction === 'retry' &&
              transient &&
              !timedOut &&
              !excludedProviders.has(model.providerId) &&
              sameModelRetries < 1 &&
              this.options.isProviderEnabled?.(model.providerId) !== false
            ) {
              sameModelRetries++;
              const retryDelayMsValue = retryDelayMs(sameModelRetries - 1, 300, 3_000);
              this.options.telemetry?.log({
                id: newId('evt'),
                ts: new Date().toISOString(),
                level: 'warn',
                source: 'agent',
                event: 'turn.retry',
                session_id: sessionId,
                turn_id: turnId,
                trace_id: traceId,
                data: {
                  attempt: attemptNumber,
                  retry: sameModelRetries,
                  model: model.ref,
                  reason: classified.family,
                  delay_ms: retryDelayMsValue,
                },
              });
              await (this.options.waitForRetry ?? delayForRetry)(retryDelayMsValue, signal);
              failedAttemptMs += retryDelayMsValue;
              continue;
            }
            const pendingBoundaryWork = (this.options.store.load(sessionId)?.messages ?? []).some(
              (entry) =>
                entry.parts.some(
                  (part) =>
                    (part.type === 'tool_call' && ['pending', 'running'].includes(part.status)) ||
                    (part.type === 'approval_request' && part.state === 'pending'),
                ),
            );
            if (
              (!rateLimited &&
                !modelUnavailable &&
                !toolsUnsupported &&
                !unsupportedFreeTier &&
                !timedOut &&
                !requestTooLarge &&
                !badCredentialStatus &&
                routingFailure.scope === 'none' &&
                classified.family !== 'stream_failure') ||
              // Every provider shares this network; switching models cannot help, so say so.
              classified.family === 'offline' ||
              pendingBoundaryWork ||
              (stopFallback && !approvedPinnedHandover) ||
              isSignalAborted(signal)
            ) {
              const currentPin = this.pinnedModelRefFor(sessionId);
              if (stopFallback && currentPin && routing?.pinnedExhaustion === 'fail')
                throw new Error(
                  `Pinned model ${currentPin} is unavailable and pinnedExhaustion is set to fail.`,
                  { cause: error },
                );
              throw error;
            }
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
              if (
                planner &&
                planner.ref !== model.ref &&
                !excludedProviders.has(planner.providerId) &&
                !attemptedModels.has(planner.ref)
              ) {
                if (handoffsThisStep >= (this.options.maxHandoffsPerStep ?? 8))
                  throw new AllCandidatesExhaustedError(
                    'Routing handoff cap reached during replanning.',
                  );
                runState.report.switches.push({
                  from: model.ref,
                  to: planner.ref,
                  reason: 'replan',
                  atStep: stepCount + 1,
                });
                if (!localQuotaReservation) handoffsThisStep++;
                attemptedModels.add(planner.ref);
                executionRole = 'planner';
                model = planner;
                assistant = { ...assistant, agentRole: 'planner' };
                this.options.store.replaceMessage(assistant);
                sameModelRetries = 0;
                continue;
              }
            }
            const maxHandoffs = this.options.maxHandoffsPerStep ?? 8;
            if (handoffsThisStep >= maxHandoffs)
              throw new AllCandidatesExhaustedError(
                `Routing stopped after ${String(handoffsThisStep)} handoffs in one ${stepKind} step. ${this.routingSummary(stepKind, routeEstimate, attemptedModels)}`,
              );
            if (toolsUnsupported)
              toolCapabilityFailures.push(formatToolCapabilityFailure(model, error));
            const fallback = this.selectFallback(
              stepKind,
              routeEstimate,
              attemptedModels,
              sessionId,
              approvedPinnedHandover,
              minimumContext,
              excludedProviders,
            );
            if (!fallback) {
              const currentPin = this.pinnedModelRefFor(sessionId);
              if (currentPin)
                throw new Error(
                  `Pinned model ${currentPin} is unavailable; no eligible handover model is available (pinnedExhaustion: ${routing?.pinnedExhaustion ?? 'handover'}).`,
                  { cause: error },
                );
              throw new AllCandidatesExhaustedError(this.exhaustedMessage(stepKind));
            }
            if (parentTurnId) {
              const fallbackReason = toolsUnsupported
                ? 'capability'
                : requestTooLarge
                  ? 'context'
                  : classified.family === 'quota_exhausted'
                    ? 'quota'
                    : rateLimited
                      ? 'rate_limit'
                      : 'error';
              this.options.telemetry?.turnUpdated(parentTurnId, {
                status: 'fallback',
                fallback_reason: fallbackReason,
                finished_at: new Date().toISOString(),
              });
              this.options.telemetry?.modelSwitch({
                session_id: sessionId,
                turn_id: parentTurnId,
                kind:
                  this.pinnedModelRefFor(sessionId) &&
                  (routing?.pinnedExhaustion ?? 'handover') === 'handover'
                    ? 'handoff'
                    : 'router_fallback',
                from_model: model.ref,
                to_model: fallback.ref,
                to_provider: fallback.providerId,
                reason: fallbackReason,
                data: { trace_id: traceId },
              });
              this.options.telemetry?.log({
                id: newId('evt'),
                ts: new Date().toISOString(),
                level: 'warn',
                source: 'router',
                event: 'turn.fallback',
                session_id: sessionId,
                turn_id: parentTurnId,
                trace_id: traceId,
                data: { from_model: model.ref, to_model: fallback.ref, reason: fallbackReason },
              });
            }
            attemptedModels.add(fallback.ref);
            runState.report.switches.push({
              from: model.ref,
              to: fallback.ref,
              reason: localQuotaReservation ? 'quota' : classified.family,
              atStep: stepCount + 1,
            });
            // A local reservation refusal never reached the provider; it must not use up the
            // switch budget that protects against slow or failing upstream requests.
            if (!localQuotaReservation) handoffsThisStep++;
            const currentPin =
              this.options.getPinnedModelRef?.() ?? this.pinnedModelRefFor(sessionId);
            if (currentPin) {
              this.pinnedHandoverModels.set(sessionId, fallback.ref);
              this.pinnedHandoverSourcePins.set(sessionId, currentPin);
            }
            const visibleHandover =
              streamedText.length > 0 ||
              approvedPinnedHandover ||
              Boolean(
                this.pinnedModelRefFor(sessionId) &&
                (routing?.pinnedExhaustion ?? 'handover') === 'handover',
              );
            const handoffReason = toolsUnsupported
              ? 'capability'
              : requestTooLarge
                ? 'context'
                : classified.family === 'quota_exhausted'
                  ? 'quota'
                  : rateLimited
                    ? 'rate_limit'
                    : 'error';
            const interruptedAt = new Date().toISOString();
            const interruptedMessage: Message = {
              ...assistant,
              modelRef: model.ref,
              ...(streamedText.length > 0
                ? {
                    interrupted: {
                      reason: formatClassifiedFailure(classified.family, error),
                      at: interruptedAt,
                    },
                    modelAttempts,
                    parts: streamedParts.parts,
                  }
                : {}),
            };
            if (visibleHandover) this.options.store.replaceMessage(interruptedMessage);
            const briefing = buildBriefing(
              taskRecord,
              visibleHandover ? [...messages, interruptedMessage] : messages,
              fallback,
              Math.floor(fallback.contextWindow * 0.25),
              this.estimates,
              {
                from: model.ref,
                to: fallback.ref,
                reason: handoffReason,
                failed: true,
                omittedContext:
                  'This packet summarizes Ferry task records and recent turns; older turns may be outside the target model’s retained history.',
                ...(visibleHandover ? { partialText: streamedText } : {}),
              },
            );
            if (visibleHandover) {
              contextMessages = [...contextMessages, interruptedMessage];
              assistant = this.options.store.appendMessage(
                sessionId,
                'assistant',
                [],
                fallback.ref,
                new Date(),
                executionRole,
              );
              this.options.emit({ type: 'session.message', message: assistant });
              streamedText = '';
              streamedTextPartId = PartIdSchema.parse(newId('part'));
              streamedParts.messageId = assistant.id;
              streamedParts.parts = [];
              const explanation =
                classified.family === 'quota_exhausted'
                  ? `${model.name} reached its usage limit; continuing with ${fallback.name}.`
                  : badCredentialStatus
                    ? `${model.name} could not continue because of a credentials error; continuing with ${fallback.name}.`
                    : toolsUnsupported
                      ? `${model.name} rejected tool calling; continuing with ${fallback.name}.`
                      : `${model.name} failed with ${formatClassifiedFailure(classified.family, error)}; continuing with ${fallback.name}.`;
              const marker = createHandoffMarker(
                model.ref,
                fallback.ref,
                handoffReason,
                briefing,
                explanation,
              );
              this.addPart(sessionId, {
                type: 'handoff_marker',
                id: PartIdSchema.parse(newId('part')),
                from: marker.from as ModelRef,
                to: marker.to as ModelRef,
                reason: marker.reason,
                briefingTokens: marker.briefingTokens,
                explanation: marker.explanation,
                trigger: 'reactive',
              });
              system += `\n\n[Ferry handover packet]\n${briefing.text}`;
            } else {
              system += `\n\n[Ferry retry attribution] ${model.name} produced no visible output; ${fallback.name} is answering this step after ${handoffReason}.`;
            }
            model = fallback;
            sameModelRetries = 0;
          }
        }
        this.activeMessageParts.delete(sessionId);
        this.options.onUsage?.({
          id: pendingPaidUsageId ?? newId('usage'),
          providerId: model.providerId,
          modelRef: model.ref,
          occurredAt: new Date().toISOString(),
          sessionId,
          stepKind,
          inputTokens: generated.inputTokens ?? 0,
          outputTokens: generated.outputTokens ?? 0,
          ...(generated.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: generated.reasoningTokens }),
          latencyMs: stepDurationMs,
          status: 'success',
        });
        this.emitStructuredEvent(sessionId, {
          id: newId('event'),
          type: 'usage',
          inputTokens: generated.inputTokens ?? 0,
          outputTokens: generated.outputTokens ?? 0,
          ...(generated.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: generated.reasoningTokens }),
          durationMs: stepDurationMs,
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
        if (generated.reasoning || generated.reasoningProviderMetadata)
          parts = [
            ...parts,
            {
              type: 'reasoning',
              id: PartIdSchema.parse(newId('part')),
              text: generated.reasoning ?? '',
              producedBy: model.ref,
              ...(generated.reasoningProviderMetadata
                ? { providerMetadata: generated.reasoningProviderMetadata }
                : {}),
            },
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
        assistant = {
          ...assistant,
          modelRef: model.ref,
          turnId: activeTurnId ?? undefined,
          providerReportedModelId: generated.responseModel ?? null,
          parts,
          modelAttempts,
        };
        this.options.store.replaceMessage(assistant);
        session = this.options.store.updateSession(sessionId, { modelRef: model.ref });
        this.options.emit({ type: 'session.updated', session });
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
            producedBy: model.ref,
            tool: call.name,
            title: definition.title,
            args: parsed.value as Record<string, unknown>,
            status: 'running',
            output: null,
            changes: [],
            durationMs: null,
          };
          this.addPart(sessionId, toolPart);
          this.options.telemetry?.log({
            id: newId('evt'),
            ts: new Date().toISOString(),
            level: 'info',
            source: 'tool',
            event: 'tool.call',
            session_id: sessionId,
            trace_id: traceId,
            data: { tool: call.name, input: parsed.value },
          });
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
            const beforeCommand =
              call.name === 'run_command'
                ? await snapshotRunFiles(this.options.workspace, this.options.dataDir)
                : undefined;
            const result = await raceAbort(
              Promise.resolve(
                definition.execute(parsed.value, { signal, task: taskRecord, model }),
              ),
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
            this.options.telemetry?.log({
              id: newId('evt'),
              ts: new Date().toISOString(),
              level: 'info',
              source: 'tool',
              event: 'tool.result',
              session_id: sessionId,
              trace_id: traceId,
              data: { tool: call.name, output: output.text },
            });
            const changes = Array.isArray(value)
              ? value.filter(isFileChange)
              : isFileChange(value)
                ? [value]
                : [];
            const purpose = `${call.name} via Ferry tool`;
            const commandSucceeded =
              value && typeof value === 'object' && 'exitCode' in value && value.exitCode === 0;
            const commandChanges =
              beforeCommand && commandSucceeded
                ? changedRunFiles(
                    beforeCommand,
                    await snapshotRunFiles(this.options.workspace, this.options.dataDir),
                  )
                : [];
            const fileChanges: RunReport['filesChanged'] = [
              ...commandChanges,
              ...changes.map((change) => ({
                path: change.path,
                sizeBytes:
                  change.after === null ? 0 : new TextEncoder().encode(change.after).length,
                status:
                  change.before === null
                    ? ('added' as const)
                    : change.after === null
                      ? ('deleted' as const)
                      : ('modified' as const),
              })),
            ];
            if (fileChanges.length || (definition.mutates && call.name !== 'run_command'))
              runState.mutation = true;
            for (const change of fileChanges) {
              const existing = runState.report.filesChanged.findIndex(
                (file) => file.path === change.path,
              );
              if (existing < 0) runState.report.filesChanged.push(change);
              else
                runState.report.filesChanged[existing] = {
                  ...change,
                  status:
                    runState.report.filesChanged[existing]?.status === 'added' &&
                    change.status === 'modified'
                      ? 'added'
                      : change.status,
                };
              taskRecord = touchFile(taskRecord, change.path, purpose);
            }
            for (const change of changes) taskRecord = touchFile(taskRecord, change.path, purpose);
            if (fileChanges.length) this.persistTask(taskRecord);
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
            if (error instanceof ToolPermissionDeniedError) runState.permissionDenied = true;
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
        if (!calls.length) {
          const pending = pendingRequirements(taskRecord.plan);
          if (pending.length && verificationRounds < 2) {
            if (stepCount >= maxSteps || totalTokens >= budget)
              return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'limit');
            verificationRounds++;
            // Inject one system turn without inventing a user request.
            verificationNote = `Verification round ${String(verificationRounds)}/2: before finishing, check these pending items with tools and call update_plan with status + evidence (or skipped with a reason). For web pages, read the visible text from check_page against each item (for example raw Markdown symbols where formatted text is expected) and fix what does not match:\n${pending.map((item) => `- ${item.id}: ${item.text}`).join('\n')}\nThen give a short summary.`;
            rolesEnabled = false;
            continue;
          }
          // The user wrote while this step ran: answer that message before finishing.
          const seen = this.contextUserIds.get(sessionId);
          const unseen = (this.options.store.load(sessionId)?.messages ?? []).some(
            (message) => message.role === 'user' && seen && !seen.has(message.id),
          );
          if (unseen && stepCount < maxSteps && totalTokens < budget) continue;
          return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'completed');
        }
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
      const pinnedPolicyFailure =
        error instanceof Error && error.message.startsWith('Pinned model ');
      const message = poolExhausted
        ? error.message
        : pinnedPolicyFailure
          ? error.message
          : formatAttemptSummary(attemptFailures, providerDetail);
      const runState = this.runReports.get(sessionId);
      const permissionDenied =
        runState?.permissionDenied === true ||
        error instanceof ToolPermissionDeniedError ||
        (pinnedPolicyFailure &&
          error instanceof Error &&
          /handover was declined/i.test(error.message));
      const providerFailure =
        poolExhausted || (routingFailurePending && attemptFailures.length > 0);
      if (runState?.mutation && providerFailure && !permissionDenied) {
        const reason =
          attemptFailures.length &&
          attemptFailures.every((attempt) =>
            ['rate_limit', 'quota_exhausted'].includes(attempt.kind),
          )
            ? 'all available models were busy (rate limits)'
            : message;
        const attempted = taskRecord.nextStep ?? runState.lastStep;
        // Internal role/handover wording ("Editor should apply…") is not meaningful to the user.
        const stepLabel =
          !attempted || /planner|editor|handoff|briefing/i.test(attempted)
            ? 'last step'
            : attempted;
        const warning = `Final check skipped (${stepLabel}): ${reason}`;
        runState.report.warnings.push(warning);
        this.addPart(sessionId, {
          type: 'text',
          id: PartIdSchema.parse(newId('part')),
          text: `Files changed:\n${runState.report.filesChanged.map((file) => `${file.path}: ${String(file.sizeBytes)} bytes (${file.status})`).join('\n') || taskRecord.touchedFiles.map((file) => file.path).join('\n')}\n\n${warning}`,
        });
        this.options.emit({ type: 'toast', tone: 'warning', message: warning });
        return this.finish(sessionId, taskRecord, stepCount, totalTokens, 'completed');
      }
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
            ...(attempt.id ? { id: attempt.id } : {}),
            ...(attempt.attempt ? { attempt: attempt.attempt } : {}),
            ...(attempt.providerKeyId ? { providerKeyId: attempt.providerKeyId } : {}),
            ...(attempt.outputStarted !== undefined
              ? { outputStarted: attempt.outputStarted }
              : {}),
            ...(attempt.fallbackReason ? { fallbackReason: attempt.fallbackReason } : {}),
            status: attempt.status,
            latencyMs: attempt.latencyMs,
            errorKind: attempt.kind,
          })),
        });
      this.options.emit({ type: 'toast', tone: 'error', message });
      const failedSession = this.options.store.updateSession(sessionId, {
        status: 'error',
        runPhase: undefined,
        inFlight: false,
        runReport: this.persistRunReport(sessionId, stepCount, 'error'),
      });
      this.options.emit({ type: 'session.updated', session: failedSession });
      throw error;
    } finally {
      this.runReports.delete(sessionId);
      this.sessionBadKeys.delete(sessionId);
      this.pinnedHandoverModels.delete(sessionId);
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
    minimumContext = 0,
  ): ModelInfo | undefined {
    // A manual pin applies to every model request, including planner and editor steps.
    if (this.pinnedModelRefFor(sessionId))
      return this.selectModel(step, inputTokens, previous, sessionId, minimumContext);
    const configured =
      role === 'planner'
        ? this.options.profile.roles.plannerModelRef
        : this.options.profile.roles.editorModelRef;
    const baseline = this.selectModel(step, inputTokens, previous, sessionId, minimumContext);
    if (
      !configured &&
      baseline?.ref === this.runReports.get(sessionId)?.report.ownerModel &&
      this.options.routingSettings?.().stickySessions !== false
    )
      return baseline;
    const candidates = scoreModels({
      models: this.options.catalog.models,
      capacity: this.options.capacity(),
      profile: this.options.profile,
      step,
      estimate: {
        inputTokens,
        contextTokens: this.contextFitEstimate(inputTokens),
        minimumContext,
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
    minimumContext = 0,
    dispatchExcluded: ReadonlySet<string> = new Set(),
  ): ModelInfo | undefined {
    const pinnedModelRef = this.pinnedModelRefFor(sessionId);
    if (pinnedModelRef)
      return this.options.catalog.models.find((model) => model.ref === pinnedModelRef);
    const locked = this.sessionModelLocks.get(sessionId);
    const softBypassed = this.softQuotaBypasses.get(sessionId);
    const withinFailedSize = (model: ModelInfo) =>
      (this.requestTooLargeAt.get(model.ref) ?? Number.POSITIVE_INFINITY) <= inputTokens;
    const routing = this.options.routingSettings?.();
    const stickyRoute = routing?.stickySessions
      ? this.sticky.getRoute(sessionId, this.now())
      : undefined;
    const stickyRef = stickyRoute?.modelRef;
    const eligible = (model: ModelInfo) =>
      !this.providerKeysExhausted(sessionId, model.providerId, model.ref) &&
      !softBypassed?.has(model.ref) &&
      !dispatchExcluded.has(model.ref) &&
      !locked?.has(model.ref) &&
      !(routing?.carefulModelRetirement && this.retiredModels.has(model.ref)) &&
      !withinFailedSize(model);
    const ownerRef = this.runReports.get(sessionId)?.report.ownerModel;
    const ownerFirst = (models: ModelInfo[]) =>
      routing?.stickySessions === false
        ? models
        : [
            ...models.filter((model) => model.ref === ownerRef),
            ...models.filter((model) => model.ref !== ownerRef),
          ];
    const resolved = this.options.resolveCandidates?.(this.options.profile, step, inputTokens);
    if (resolved)
      return this.selectResilient(
        ownerFirst(
          preferStickyAffinity(
            resolved.filter((model) => eligible(model) && model.contextWindow >= minimumContext),
            stickyRoute,
            this.options.profile.affinityMode,
            (providerId) => this.options.providerAffinityKey?.(providerId, sessionId) ?? undefined,
          ),
        ),
      );
    const candidates = scoreModels({
      models: this.options.catalog.models,
      capacity: this.pacingCapacity(),
      profile: this.options.profile,
      step,
      estimate: {
        inputTokens,
        contextTokens: this.contextFitEstimate(inputTokens),
        minimumContext,
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
      ownerFirst(
        candidates.flatMap((item) => {
          const model = this.options.catalog.models.find((candidate) => candidate.ref === item.ref);
          if (
            (model && this.providerKeysExhausted(sessionId, model.providerId, item.ref)) ||
            softBypassed?.has(item.ref) ||
            dispatchExcluded.has(item.ref) ||
            locked?.has(item.ref) ||
            (routing?.carefulModelRetirement && this.retiredModels.has(item.ref)) ||
            (this.requestTooLargeAt.get(item.ref) ?? Infinity) <= inputTokens
          )
            return [];
          return model ? [model] : [];
        }),
      ),
    );
    return selected;
  }

  private selectFallback(
    step: import('@ferry/shared').StepKind,
    inputTokens: number,
    attemptedRefs: ReadonlySet<string>,
    sessionId: string,
    allowPinnedHandover = false,
    minimumContext = 0,
    excludedProviders: ReadonlySet<string> = new Set(),
  ): ModelInfo | undefined {
    // Session dependencies rotate through provider keys before this model fallback path is reached.
    const pinnedExhaustion = this.options.routingSettings?.().pinnedExhaustion ?? 'handover';
    if (
      this.pinnedModelRefFor(sessionId) &&
      pinnedExhaustion !== 'handover' &&
      !allowPinnedHandover
    )
      return undefined;
    const locked = this.sessionModelLocks.get(sessionId);
    const candidates = this.options.resolveCandidates?.(this.options.profile, step, inputTokens);
    const retirementEnabled = this.options.routingSettings?.().carefulModelRetirement;
    if (candidates)
      return this.selectResilient(
        candidates.filter(
          (candidate) =>
            !excludedProviders.has(candidate.providerId) &&
            !this.providerKeysExhausted(sessionId, candidate.providerId, candidate.ref) &&
            !attemptedRefs.has(candidate.ref) &&
            candidate.contextWindow >= minimumContext &&
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
        minimumContext,
        requiresTools: true,
      },
      ...(previousModelRef ? { previousModelRef } : {}),
      ...(this.options.routingSettings ? { routing: this.options.routingSettings() } : {}),
      ...(this.reliability.length ? { reliability: this.reliability } : {}),
    });
    const remaining = ranked.flatMap((candidate) => {
      if (
        excludedProviders.has(candidate.ref.split('/')[0] ?? '') ||
        this.providerKeysExhausted(sessionId, candidate.ref.split('/')[0] ?? '', candidate.ref) ||
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
        this.resilience.active('model', model.ref, now),
        this.resilience.active('key', providerId, now),
        this.resilience.active('provider', providerId, now),
      ].filter((entry): entry is ResilienceEntry => entry !== undefined);
      return {
        model,
        index,
        deferred: deferred.has(model.ref),
        reset: active.length ? Math.max(...active.map((entry) => Date.parse(entry.expiresAt))) : 0,
      };
    });
    const availableRefs = new Set(
      this.resilience.availableModelRefs(
        ranked.map(({ model }) => model.ref),
        now,
      ),
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
    if (status !== 'paused') {
      taskRecord = {
        ...taskRecord,
        plan: taskRecord.plan.map((item) =>
          pendingRequirements([item]).length
            ? { ...item, status: 'skipped', evidence: 'not verified' }
            : item,
        ),
      };
      this.persistTask(taskRecord);
    }
    if (status === 'limit')
      this.options.emit({
        type: 'toast',
        tone: 'warning',
        message: `FERRY_RUN_LIMIT:${steps >= (this.options.maxSteps ?? 40) ? 'max_steps' : 'token_budget'}:${String(steps)}`,
      });
    const report = this.persistRunReport(sessionId, steps, status);
    const session = this.options.store.updateSession(sessionId, {
      status: 'idle',
      runPhase: undefined,
      inFlight: false,
      runReport: report,
    });
    this.emitStructuredEvent(sessionId, {
      id: newId('event'),
      type: 'status',
      status,
      message: `Agent run ${status}.`,
      timestamp: new Date().toISOString(),
    });
    this.options.emit({ type: 'session.updated', session });
    const seenUserMessageIds = [...(this.contextUserIds.get(sessionId) ?? [])];
    this.contextUserIds.delete(sessionId);
    return {
      session,
      taskRecord,
      steps,
      tokens,
      status,
      report,
      warnings: report?.warnings ?? [],
      seenUserMessageIds,
    };
  }

  private recordSuccessfulStep(
    sessionId: string,
    model: ModelInfo,
    generated: GeneratedStep,
    inputTokens: number,
  ): void {
    const report = this.runReports.get(sessionId)?.report;
    if (!report) return;
    report.ownerModel ??= model.ref;
    this.options.store.updateSession(sessionId, { ownerModelRef: report.ownerModel });
    const used = report.modelsUsed.find((entry) => entry.model === model.ref);
    if (used) used.steps++;
    else report.modelsUsed.push({ model: model.ref, steps: 1 });
    report.tokens.input += generated.inputTokens ?? inputTokens;
    report.tokens.output += generated.outputTokens ?? this.estimates(generated.text ?? '');
    report.tokens.reasoning += generated.reasoningTokens ?? 0;
  }

  private persistRunReport(
    sessionId: string,
    steps: number,
    outcome: RunReport['outcome'],
  ): RunReport | undefined {
    const state = this.runReports.get(sessionId);
    if (!state) return undefined;
    const checklist = this.options.store.load(sessionId)?.taskRecord.plan ?? [];
    const warnings = [
      ...new Set([
        ...state.report.warnings,
        ...checklist
          .filter((item) => item.status === 'failed')
          .map(
            (item) =>
              `Requirement failed: ${item.text}${item.evidence ? ` — ${item.evidence}` : ''}`,
          ),
      ]),
    ];
    const report: RunReport = {
      ...state.report,
      durationMs: Math.max(0, this.now() - state.startedAt),
      steps,
      checklist,
      warnings,
      outcome: outcome === 'completed' && warnings.length ? 'completed_with_warnings' : outcome,
    };
    const lastMessage = this.options.store
      .load(sessionId)
      ?.messages.findLast((message) => message.role === 'assistant');
    if (lastMessage) {
      const message = { ...lastMessage, runReport: report };
      this.options.store.replaceMessage(message);
      this.options.emit({ type: 'session.message', message });
    }
    this.options.emit({
      type: 'run.completed',
      sessionId: sessionId as Session['id'],
      outcome: report.outcome,
      warnings: report.warnings,
      report,
    });
    return report;
  }

  private async paceLimit(
    sessionId: string,
    model: ModelInfo,
    delayMs: number | null,
    durationMs: number | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    const settings = this.options.routingSettings?.();
    const state = this.runReports.get(sessionId);
    const cap = (settings?.paceMaxWaitSeconds ?? 30) * 1000;
    // A declared long window never becomes a short limit just because it resets soon.
    if (
      !state ||
      settings?.paceShortLimits === false ||
      delayMs === null ||
      !Number.isFinite(delayMs) ||
      delayMs <= 0 ||
      delayMs > 120_000 ||
      (durationMs !== null && durationMs > 120_000) ||
      state.waitMs + delayMs > cap
    )
      return false;
    state.waitMs += delayMs;
    const reason = durationMs === null ? 'short rate limit' : 'per-minute limit';
    const provider =
      this.options.capacity().providers.find((entry) => entry.id === model.providerId)?.name ??
      model.providerId;
    this.emitStructuredEvent(sessionId, {
      type: 'status',
      id: newId('event'),
      status: 'waiting',
      waitUntil: new Date(this.now() + delayMs).toISOString(),
      message: `Waiting ${String(Math.ceil(delayMs / 1000))}s for ${provider}'s ${reason}`,
      timestamp: new Date(this.now()).toISOString(),
    });
    const start = this.now();
    try {
      await (this.options.waitForRetry ?? delayForRetry)(delayMs, signal);
    } finally {
      state.report.waits.push({
        provider: model.providerId,
        seconds: Math.max(0, this.now() - start) / 1000,
        reason,
      });
    }
    return true;
  }

  /** Temporarily keep paceable models in the eligible set so the dispatch branch can wait. */
  private pacingCapacity(): CapacityView {
    const capacity = this.options.capacity();
    const settings = this.options.routingSettings?.();
    if (settings?.paceShortLimits === false) return capacity;
    const cap = (settings?.paceMaxWaitSeconds ?? 30) * 1000;
    const paceable = new Set<string>();
    const providers = capacity.providers.map((provider) => {
      const windows = provider.windows.filter((window) => {
        const delay = Date.parse(window.resetAt ?? '') - this.now();
        if (window.durationMs && window.durationMs <= 120_000 && delay > 0 && delay <= cap) {
          paceable.add(window.modelRef ?? provider.id);
          return false;
        }
        return true;
      });
      return { ...provider, windows };
    });
    const tokensPerMinuteRemaining = Object.fromEntries(
      Object.entries(capacity.tokensPerMinuteRemaining ?? {}).filter(
        ([key]) => !paceable.has(key) && !paceable.has(key.split('/')[0] ?? ''),
      ),
    );
    return { ...capacity, providers, tokensPerMinuteRemaining };
  }

  private isAtLeastOwner(
    candidate: ModelInfo,
    owner: ModelInfo,
    step: import('@ferry/shared').StepKind,
    inputTokens: number,
  ): boolean {
    if (Number(candidate.tier.slice(1)) < Number(owner.tier.slice(1))) return false;
    const scores = scoreModels({
      models: [owner, candidate],
      profile: this.options.profile,
      step,
      capacity: this.pacingCapacity(),
      estimate: { inputTokens, requiresTools: true },
      ...(this.options.routingSettings ? { routing: this.options.routingSettings() } : {}),
    });
    const ownerScore = scores.find((entry) => entry.ref === owner.ref)?.score;
    const candidateScore = scores.find((entry) => entry.ref === candidate.ref)?.score;
    return ownerScore !== undefined && candidateScore !== undefined
      ? candidateScore >= ownerScore
      : (candidate.quality ?? 0.35) >= (owner.quality ?? 0.35);
  }

  private restoreOwnerEligibility(sessionId: string, inputTokens: number): void {
    const capacity = this.options.capacity();
    const signalFor = (model: ModelInfo) => {
      const provider = capacity.providers.find((entry) => entry.id === model.providerId);
      return evaluateProactiveQuota({
        windows: (provider?.windows ?? []).filter(
          (window) => window.scope === 'provider' || window.modelRef === model.ref,
        ),
        stepsLeft: provider?.stepsLeftToday ?? null,
        inputTokens,
        outputTokens: 2048,
        now: this.now(),
      });
    };
    const sourcePin = this.options.getPinnedModelRef?.() ?? this.options.pinnedModelRef;
    if (sourcePin && this.pinnedHandoverModels.has(sessionId)) {
      const original = this.options.catalog.models.find((model) => model.ref === sourcePin);
      const provider = capacity.providers.find((entry) => entry.id === original?.providerId);
      if (
        original &&
        provider &&
        !this.providerKeysExhausted(sessionId, original.providerId) &&
        !['down', 'auth_invalid', 'account_disabled'].includes(provider.health) &&
        (!provider.cooldownUntil || Date.parse(provider.cooldownUntil) <= this.now()) &&
        signalFor(original).signal !== 'hard' &&
        !this.resilience.active('model', original.ref, this.now()) &&
        !this.resilience.active('provider', original.providerId, this.now()) &&
        !this.resilience.active('key', original.providerId, this.now())
      )
        this.pinnedHandoverModels.delete(sessionId);
    }
    for (const ref of this.softQuotaBypasses.get(sessionId) ?? []) {
      const candidate = this.options.catalog.models.find((model) => model.ref === ref);
      if (candidate && signalFor(candidate).signal === 'none')
        this.softQuotaBypasses.get(sessionId)?.delete(ref);
    }
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
    | 'providerHeaders'
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
  return async (input) => {
    const streamState = { outputStarted: false };
    const generate = async (dropNativeArtifacts: boolean): Promise<GeneratedStep> => {
      const { system, messages, tools, signal, onDelta, onReasoning, onProgress, modelHints } =
        input;
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
      const cache = promptCacheOptions(
        model.providerId,
        options.promptCaching?.(model) ?? true,
        sessionId,
      );
      const reasoningOptions = reasoningTransportOptions(model, input.effort);
      const providerOptions = {
        ...reasoningOptions,
        ...(Object.keys(cache).length
          ? { [model.providerId]: { ...cache, ...reasoningOptions[model.providerId] } }
          : {}),
      };
      const result = streamText({
        model: createLanguageModel(model.ref, {
          apiKey: options.apiKeys[model.providerId] ?? '',
          providerId: model.providerId,
          ...(model.gateway ? { modelName: model.gateway.modelName } : {}),
          ...(options.providerHeaders?.[model.providerId]
            ? { headers: options.providerHeaders[model.providerId] }
            : {}),
          ...(options.providerBaseUrls?.[model.providerId]
            ? { baseUrl: options.providerBaseUrls[model.providerId] }
            : {}),
          fetch: observationFetch,
          sessionId,
        }),
        system,
        ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
        ...(Object.keys(reasoningOptions).length ? { maxOutputTokens: model.maxOutput } : {}),
        messages: sanitizeProviderMessages(
          toModelMessages(
            messages,
            model,
            modelHints.toolProtocol !== 'native',
            dropNativeArtifacts,
          ),
          model.providerId as import('@ferry/providers').MessageNormalizationProvider,
        ),
        tools: sdkTools as unknown as ToolSet,
        ...(input.toolChoice === 'required' ? { toolChoice: 'required' as const } : {}),
        abortSignal: signal,
        maxRetries: 0,
        onError: () => undefined,
      });
      let text = '';
      let reasoning = '';
      let reasoningAvailable = false;
      let reasoningProviderMetadata: ProviderMetadata | undefined;
      let reasoningStartedAt: number | undefined;
      let thinkingDurationMs: number | undefined;
      const endThinking = () => {
        if (reasoningStartedAt !== undefined && thinkingDurationMs === undefined)
          thinkingDurationMs = Math.max(0, performance.now() - reasoningStartedAt);
      };
      for await (const part of result.stream) {
        // The SDK emits start markers locally before the provider answers.
        if (part.type !== 'start' && part.type !== 'start-step') onProgress?.();
        if (part.type === 'error') throw part.error;
        const streamPart = part as unknown as {
          type: string;
          text?: string;
          delta?: string;
          reasoning?: string;
          reasoning_content?: string;
          thought?: boolean;
          providerMetadata?: ProviderMetadata;
        };
        if (
          streamPart.type === 'reasoning-start' ||
          streamPart.type === 'reasoning-delta' ||
          streamPart.type === 'reasoning-end'
        )
          reasoningProviderMetadata = mergeProviderMetadata(
            reasoningProviderMetadata,
            streamPart.providerMetadata,
          );
        const exposedReasoning =
          normalizeReasoningPart(streamPart) ??
          streamPart.reasoning_content ??
          (streamPart.type === 'reasoning-delta' ||
          streamPart.type === 'reasoning' ||
          streamPart.thought
            ? (streamPart.delta ?? streamPart.text ?? streamPart.reasoning)
            : undefined);
        if (typeof exposedReasoning === 'string' && exposedReasoning) {
          reasoningStartedAt ??= performance.now();
          streamState.outputStarted = true;
          reasoningAvailable = true;
          reasoning += exposedReasoning;
          onReasoning?.(exposedReasoning);
        } else if (streamPart.type === 'text-delta' && typeof streamPart.text === 'string') {
          endThinking();
          streamState.outputStarted = true;
          text += streamPart.text;
          onDelta(streamPart.text);
        }
        if (/^tool-(?:input|call)/.test(streamPart.type)) {
          endThinking();
          input.onToolDelta?.();
        }
      }
      endThinking();
      const [usage, rawCalls] = await Promise.all([result.usage, result.toolCalls]);
      const finalStep = await result.finalStep;
      const providerResponse = finalStep.response;
      const reasoningTokens = reasoningTokensFromUsage(usage, finalStep.providerMetadata);
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
        ...(reasoningProviderMetadata ? { reasoningProviderMetadata } : {}),
        reasoningAvailable,
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        ...(thinkingDurationMs === undefined ? {} : { thinkingDurationMs }),
        ...(typeof providerResponse.modelId === 'string'
          ? { responseModel: providerResponse.modelId }
          : {}),
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
        finishReason: finalStep.finishReason,
      };
    };
    try {
      return await generate(false);
    } catch (error) {
      if (streamState.outputStarted || !isInvalidSignatureOrThinkingError(error)) throw error;
      return generate(true);
    }
  };
}

function toolSchemaForEstimate(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return { description: schema.description ?? 'Tool input schema' };
  }
}

export function prepareResumeTranscript(messages: readonly Message[]): Message[] {
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
  if (!tools.length && !lastAssistant.interrupted)
    return messages.filter((_message, index) => index !== lastAssistantIndex);
  if (!tools.length) return [...messages];
  if (tools.every((part) => !['pending', 'running'].includes(part.status))) return [...messages];
  const durableTools = tools.filter((part) => !['pending', 'running'].includes(part.status));
  if (!durableTools.length && lastAssistant.interrupted)
    return messages.map((message, index) =>
      index === lastAssistantIndex
        ? { ...message, parts: message.parts.filter((part) => part.type !== 'tool_call') }
        : message,
    );
  if (!durableTools.length)
    return messages.filter((_message, index) => index !== lastAssistantIndex);
  return messages.map((message, index) =>
    index === lastAssistantIndex ? { ...message, parts: durableTools } : message,
  );
}
export function toModelMessages(
  messages: readonly Message[],
  targetModel: ModelInfo | undefined,
  escapeToolResults = false,
  dropNativeArtifacts = false,
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
      if (part.type === 'text') {
        if (part.text) content.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning') {
        if (!dropNativeArtifacts && targetModel && part.producedBy === targetModel.ref)
          content.push({
            type: 'reasoning',
            text: part.text,
            ...(part.providerMetadata
              ? { providerOptions: part.providerMetadata as ProviderMetadata }
              : {}),
          });
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
        const producer = part.producedBy ?? message.modelRef;
        const providerOptions = dropNativeArtifacts
          ? undefined
          : withGemini3ThoughtSignature(
              producer === targetModel?.ref ? part.providerOptions : undefined,
              targetModel,
              message.modelRef,
            );
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
        const resultPart = toolResults.at(-1);
        if (
          resultPart?.type === 'tool-result' &&
          resultPart.output.type === 'text' &&
          modelAcceptsImages(targetModel) &&
          part.output?.images?.length
        ) {
          resultPart.output = {
            type: 'content',
            value: [
              { type: 'text', text: resultPart.output.value },
              ...part.output.images.map((image) => ({
                type: 'file' as const,
                data: { type: 'data' as const, data: image.data },
                mediaType: image.mimeType,
              })),
            ],
          };
        }
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

function compactMessageToolOutputs(
  message: Message,
  estimate: (text: string) => number,
  blobStore: InMemoryBlobStore,
  sessionId: string,
  modelName: string,
): Message | null {
  const parts = message.parts.map((part) => {
    if (
      part.type !== 'tool_call' ||
      !part.output ||
      part.output.text.startsWith('Older tool output omitted to fit ')
    )
      return part;
    const handle = part.output.recoveryHandle ?? blobStore.put(sessionId, part.output.text);
    const text = `Older tool output omitted to fit ${modelName}'s context. Recover full output with ${handle}.`;
    return {
      ...part,
      output: {
        ...part.output,
        text,
        filtered: true,
        originalTokens: part.output.originalTokens ?? estimate(part.output.text),
        filteredTokens: estimate(text),
        recoveryHandle: handle,
      },
    };
  });
  if (parts.every((part, index) => part === message.parts[index])) return null;
  return { ...message, parts };
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
  sourceModelRef: ModelRef | null,
): Record<string, Record<string, unknown>> | undefined {
  if (!targetModel || !isGemini3Model(targetModel) || hasThoughtSignature(providerOptions))
    return providerOptions;
  // Gemini's skip sentinel is only valid for calls whose signature belongs to another model.
  if (sourceModelRef === targetModel.ref) return providerOptions;
  return {
    ...providerOptions,
    google: {
      ...providerOptions?.google,
      thoughtSignature: 'skip_thought_signature_validator',
    },
  };
}

function mergeProviderMetadata(
  current: ProviderMetadata | undefined,
  next: ProviderMetadata | undefined,
): ProviderMetadata | undefined {
  if (!next) return current;
  const merged = { ...current };
  for (const [provider, metadata] of Object.entries(next)) {
    merged[provider] = { ...merged[provider], ...metadata };
  }
  return Object.keys(merged).length ? merged : undefined;
}

function isInvalidSignatureOrThinkingError(error: unknown): boolean {
  if (errorStatus(error) !== 400) return false;
  const message = providerErrorMessage(error).toLowerCase();
  return (
    /(?:invalid|missing|unknown|mismatch|malformed|unsupported)/.test(message) &&
    /(?:thought.?signature|signature|thinking(?:_block| block|_signature)?|reasoning(?:_content)?)/.test(
      message,
    )
  );
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
  if (part.type === 'handoff_marker') return '';
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
  firstTokenTimeoutMs?: number,
  maxAttemptMs?: number,
): Promise<GeneratedStep> {
  if (parentSignal.aborted)
    throw parentSignal.reason instanceof Error
      ? parentSignal.reason
      : new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    firstTokenTimer = undefined;
    // Productive streaming is not failed-attempt wall time. Once data arrives,
    // retain the progress watchdog and apply the routing budget if this attempt fails.
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new StepWatchdogError(timeoutMs);
      controller.abort(error);
      onAbort();
      rejectTimeout(error);
    }, timeoutMs);
  };
  resetWatchdog();
  if (firstTokenTimeoutMs !== undefined)
    firstTokenTimer = setTimeout(() => {
      const error = new Error(`First token timeout after ${String(firstTokenTimeoutMs)}ms`);
      controller.abort(error);
      onAbort();
      rejectTimeout(error);
    }, firstTokenTimeoutMs);
  if (maxAttemptMs !== undefined)
    deadlineTimer = setTimeout(() => {
      const error = new Error('Routing attempt timeout: failed-attempt deadline reached');
      controller.abort(error);
      onAbort();
      rejectTimeout(error);
    }, maxAttemptMs);
  try {
    return await Promise.race([
      generator(makeRequest(model, controller.signal, resetWatchdog)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    parentSignal.removeEventListener('abort', abort);
  }
}

function errorInput(error: unknown, now = Date.now()): Parameters<typeof classifyProviderError>[0] {
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
  const headers = candidate.response?.headers ?? candidate.responseHeaders ?? candidate.headers;
  const resetDelay =
    headers instanceof Headers || (headers && typeof headers === 'object')
      ? retryDelayFromHeaders(headers as Headers | Record<string, string | undefined>, now)
      : null;
  return {
    status: candidate.status,
    statusCode: candidate.statusCode ?? candidate.response?.status,
    code: candidate.code ?? candidate.data?.error?.code,
    type: candidate.type ?? candidate.data?.error?.type,
    message: candidate.data?.error?.message ?? candidate.message,
    responseBody: candidate.data ? JSON.stringify(candidate.data) : candidate.responseBody,
    ...(headers instanceof Headers || (headers && typeof headers === 'object')
      ? { headers: headers as Headers | Record<string, string | undefined> }
      : {}),
    retryAfter: candidate.retryAfter ?? (resetDelay === null ? undefined : resetDelay / 1000),
  };
}

async function delayForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      Math.max(0, ms),
    );
    const abort = () => {
      clearTimeout(timer);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('Aborted', { cause: reason }));
    };
    signal.addEventListener('abort', abort, { once: true });
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
