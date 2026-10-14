import {
  isCliModelVerified,
  resolveCliOption as resolveSharedCliOption,
  type CliConnection,
  type CliConnectionKind,
  type CliConnectionVerifyResult,
  type CliModelCapabilities,
  type CliModelReceipt,
  type CliOption,
  type CliOptionLayer,
  type CliOptionPatch,
  type Effort,
  type ModelInfo,
  type ModelRef,
  type Provider,
  ProviderIdSchema,
  redactKnownSecretText,
} from '@ferry/shared';
import { createHash } from 'node:crypto';
import {
  CliTransportError,
  isCliTransportError,
  isOpenCodeAcpError,
  runClaudeCodeCli,
  runCodexCli,
  runOpenCodeAcp,
  type CliCallerTool,
  type CliConversationMessage,
  type CliTransportErrorKind,
  type CliTransportInput,
  type CliTurnResult,
} from '@ferry/delegate';
import type { FerryServices } from './services.js';
import { getCliConnectionService, type CliConnectionService } from './cli-connections.js';

/** One caller-owned generation request routed to an installed-CLI transport. */
export interface CliBrokerRequest {
  connection: CliConnection;
  model: CliModelCapabilities;
  options: CliOption;
  messages: readonly CliConversationMessage[];
  tools: readonly CliCallerTool[];
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  fastServiceTierId?: string;
  timeoutMs?: number;
  /** OpenCode credential preference; other kinds ignore it. */
  credentialMode?: 'installed' | 'anonymous' | 'ferry';
  credentialProvider?: string;
  /**
   * Selected saved Ferry key for `credentialMode: 'ferry'`. Supplied by the integration layer from
   * the user's chosen secret; the broker never reads or copies it. `ferry` without a key is rejected
   * rather than silently substituting another credential.
   */
  apiKey?: string;
  onText?: (text: string) => void;
  onProgress?: () => void;
  onUsageSnapshot?: CliTransportInput['onUsageSnapshot'];
  /** Explicit executable seam for offline fixtures. Never set in production. */
  executable?: string;
  executableArgs?: string[];
}

export type CliTurnRunner = (request: CliBrokerRequest) => Promise<CliTurnResult>;

/** A pinned manual CLI generation routed through the shared admission + option policy. */
export interface CliDispatchInput {
  surface: 'native' | 'gateway';
  modelRef: ModelRef;
  messages: readonly CliConversationMessage[];
  tools: readonly CliCallerTool[];
  signal: AbortSignal;
  onText?: (text: string) => void;
  onProgress?: () => void;
  /** Profile `cliDefaults[ref]`, applied below an explicit conversation override. */
  profileCliDefault?: CliOption | undefined;
  /** Explicit conversation override; highest priority. */
  optionOverride?: CliOption | undefined;
  /** Estimated prompt tokens, used only to bound a controlled admission when capacity is unknown. */
  inputTokens?: number;
  timeoutMs?: number;
  /** Selected saved Ferry key for `credentialMode: 'ferry'`. */
  apiKey?: string;
  /** Explicit executable seam for offline fixtures. Never set in production. */
  executable?: string;
  executableArgs?: string[];
}

export interface CliDispatchResult {
  connection: CliConnection;
  model: CliModelCapabilities;
  option: CliOption;
  result: CliTurnResult;
}

/** Bounded single-generation queue limits; one active turn per connection, small fair backlog. */
export const CLI_QUEUE_LIMIT = 8;
export const CLI_VERIFY_TIMEOUT_MS = 30_000;

const kindTransport: Record<CliConnectionKind, ModelInfo['transport']> = {
  'codex-cli': 'codex_cli',
  'claude-code-cli': 'claude_code_cli',
  'opencode-cli': 'opencode_cli',
};

const providerNames: Record<CliConnectionKind, string> = {
  'codex-cli': 'Codex CLI',
  'claude-code-cli': 'Claude Code',
  'opencode-cli': 'OpenCode CLI',
};

const KNOWN_EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Conservative capacity placeholders used only when the CLI never reported a real context/output
 * limit. They are inert whenever `capacityKnown` is false; no native model capacity is invented.
 */
const UNKNOWN_CONTEXT_WINDOW = 8_192;
const UNKNOWN_MAX_OUTPUT = 2_048;

/**
 * Controls advertised by the CLI that this beta's bridge cannot run. The reason describes a bridge
 * support/isolation limitation; it does not claim the control inherently does anything native.
 */
const BRIDGE_UNSUPPORTED_EFFORTS: Readonly<Record<string, string>> = {
  ultra:
    'The "ultra" control is not supported by this beta CLI bridge (native isolation is not verified).',
};

/**
 * Advertised-but-unrunnable controls for a model, keyed by the raw discovery token so the UI can
 * disable them with an explanation without dropping the token the CLI reported.
 */
export function unsupportedEffortsFor(
  model: Pick<CliModelCapabilities, 'efforts' | 'unsupportedEfforts'>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const effort of model.efforts) {
    const reason = model.unsupportedEfforts?.[effort] ?? BRIDGE_UNSUPPORTED_EFFORTS[effort];
    if (reason) result[effort] = reason;
  }
  return result;
}

/**
 * Validation message for an explicit CLI option patch against one model's discovered capabilities,
 * or null when every explicit value is supported. Absent fields and an explicit null effort are not
 * rejected here; they preserve or clear the stored override. Advertised-but-unrunnable controls are
 * rejected here exactly as dispatch rejects them.
 */
export function cliOptionError(
  modelRef: ModelRef,
  model: CliModelCapabilities,
  patch: CliOptionPatch,
): string | null {
  if (patch.effort != null) {
    const reason = unsupportedEffortsFor(model)[patch.effort];
    if (reason) return `${patch.effort} is unavailable for ${modelRef}: ${reason}`;
    if (!model.efforts.includes(patch.effort))
      return `${patch.effort} is not a supported effort for ${modelRef}.`;
  }
  if (patch.speed !== undefined && !model.speeds.includes(patch.speed))
    return `${patch.speed} is not a supported speed for ${modelRef}.`;
  return null;
}

/** Merge an option patch over the stored override, preserving raw effort tokens. */
export function mergeCliOption(current: CliOption | undefined, patch: CliOptionPatch): CliOption {
  return {
    effort: 'effort' in patch ? (patch.effort ?? null) : (current?.effort ?? null),
    speed: patch.speed ?? current?.speed ?? 'standard',
  };
}

/**
 * Transport-owned controlled admission bound for a manual generation when the CLI never reported a
 * real context window. It is an explicit ferry policy bound (not native capacity): realistic ordinary
 * Ferry text/tool prompts fit, an oversized request is rejected clearly, and the caller context is
 * never silently dropped. `capacityKnown` stays false for these models.
 */
export const MANUAL_UNKNOWN_CAPACITY_INPUT_BOUND = 64_000;

export interface CliOptionLayers {
  /** Profile `cliDefaults[ref]` (lower priority than an explicit conversation override). */
  profileDefault?: CliOptionLayer | undefined;
  /** Connection per-model default (`cliConnections[kind].modelDefaults[ref]`). */
  connectionModelDefault?: CliOptionLayer | undefined;
  /** Connection default options (`cliConnections[kind].defaultOptions`). */
  connectionDefault?: CliOptionLayer | undefined;
  /** Explicit conversation/session override; highest priority. */
  conversation?: CliOptionLayer | undefined;
}

/**
 * Resolve the effective CLI option for one model by delegating to the single shared pure resolver
 * (`@ferry/shared`), so Core, the Ferry CLI and the GUI cannot disagree. Highest defined layer field
 * wins; an explicit `effort: null` selects the reported CLI default and stops fall-through; an absent
 * field inherits. `fast` is never defaulted on.
 */
export function resolveCliOption(model: CliModelCapabilities, layers: CliOptionLayers): CliOption {
  return resolveSharedCliOption({
    model,
    ...(layers.conversation ? { conversation: layers.conversation } : {}),
    ...(layers.profileDefault ? { profile: layers.profileDefault } : {}),
    ...(layers.connectionModelDefault ? { connectionModel: layers.connectionModelDefault } : {}),
    ...(layers.connectionDefault ? { connection: layers.connectionDefault } : {}),
  });
}

export interface CliDispatchAdmission {
  ok: boolean;
  statusCode: number;
  message: string;
}

/**
 * Decide whether a manual (pinned) CLI generation may dispatch on one surface. Discovery and
 * verification are prerequisites; metered or unknown-billing capacity additionally requires the
 * existing spending authorization. An included subscription is never treated as free and never
 * authorizes metered spend.
 */
export function cliManualAdmission(
  connection: CliConnection,
  model: CliModelCapabilities,
  surface: 'native' | 'gateway',
  options: {
    authorizeSpend?: (connection: CliConnection, model: CliModelCapabilities) => boolean;
    inputTokens?: number;
  } = {},
): CliDispatchAdmission {
  if (!connection.surfaces[surface])
    return {
      ok: false,
      statusCode: 400,
      message: `${connection.kind} is not opted in for the ${surface} surface. Enable it in Providers & keys first.`,
    };
  if (!isCliModelVerified(connection, model.ref))
    return {
      ok: false,
      statusCode: 400,
      message: `${model.name} is not verified on ${connection.kind}. Run Verify for this connection before sending.`,
    };
  if (connection.account.state !== 'signed_in' || connection.account.key === null)
    return {
      ok: false,
      statusCode: 401,
      message: `${connection.kind} has no signed-in account identity. Sign in to the CLI and refresh, then verify again.`,
    };
  if (model.hidden)
    return { ok: false, statusCode: 400, message: `${model.name} is not currently available.` };
  if (
    model.contextWindow == null &&
    (options.inputTokens ?? 0) > MANUAL_UNKNOWN_CAPACITY_INPUT_BOUND
  )
    return {
      ok: false,
      statusCode: 400,
      message: `${model.name} did not report a context window, so only a bounded request (policy limit ${MANUAL_UNKNOWN_CAPACITY_INPUT_BOUND.toLocaleString('en-US')} input tokens) is admitted; this one is larger. Use a model with a known context, or split the request. The transport never silently drops caller context.`,
    };
  if (!isNonSpendingBilling(model.billing)) {
    if (!options.authorizeSpend?.(connection, model))
      return {
        ok: false,
        statusCode: 402,
        message: `${model.name} is billed as ${model.billing}; dispatching it needs an existing monetary spending authorization and a known price budget. No zero-cost charge was assumed.`,
      };
  }
  return { ok: true, statusCode: 200, message: '' };
}

/** True for a caller/native abort (DOMException or native transport abort), never a provider fault. */
export function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'NativeAbortError';
}

const QUOTA_EXHAUSTION =
  /quota|usage limit|insufficient|exhaust|out of credits|billing hard limit/i;

/**
 * Map a genuine OpenCode ACP failure category onto the shared transport kinds. A temporary rate
 * limit (`busy`) stays distinct from an exhausted account quota; only an explicit exhaustion signal
 * is promoted to `exhausted_capacity`. Account, status and reset metadata are preserved by the
 * caller.
 */
export function normalizeOpenCodeCategory(
  category: string,
  message: string,
  statusCode?: number,
): CliTransportErrorKind {
  switch (category) {
    case 'busy':
      return 'temporary_rate_limit';
    case 'model_unavailable':
      return 'unavailable_model';
    case 'unsupported_option':
      return 'unsupported_capability';
    case 'credential':
      return 'authentication';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'provider':
      return statusCode === 429 && QUOTA_EXHAUSTION.test(message)
        ? 'exhausted_capacity'
        : 'provider_error';
    case 'protocol':
    default:
      return 'provider_error';
  }
}

function knownReasoningEfforts(model: CliModelCapabilities): Effort[] {
  const unsupported = unsupportedEffortsFor(model);
  return model.efforts.filter(
    (effort): effort is Effort =>
      (KNOWN_EFFORTS as readonly string[]).includes(effort) && unsupported[effort] === undefined,
  );
}

/**
 * Encode the caller conversation into the single prompt the installed OpenCode ACP transport accepts,
 * preserving real roles, tool call ids and tool results. Ferry never invents a tool result.
 */
export function encodeOpenCodePrompt(
  messages: readonly CliConversationMessage[],
  tools: readonly CliCallerTool[],
): string {
  const mappings = tools
    .map((tool, index) => `${tool.name} = ferry_tools_tool_${String(index)}`)
    .join('\n');
  const conversation = messages
    .map((message) => {
      const calls =
        message.tool_calls
          ?.map(
            (call) =>
              `Caller tool request ${call.id}: ${call.function.name}(${call.function.arguments})`,
          )
          .join('\n') ?? '';
      return `[${message.role}${message.tool_call_id ? ` result for ${message.tool_call_id}` : ''}]\n${message.content ?? ''}${calls ? `\n${calls}` : ''}`;
    })
    .join('\n\n');
  const continuation =
    messages.at(-1)?.role === 'tool'
      ? 'The caller already executed the last tool request. Continue from its real result; do not repeat a completed request.'
      : '';
  return `Continue the caller conversation below and answer its latest request. Preserve the caller system instructions. Tool results below are real outputs, not requests to run a tool. ${continuation}\nUse only these caller tool names; never a native tool:\n${mappings || '(No caller tools)'}\n\n${conversation}`;
}

/**
 * Default transport dispatch: reviewed per-kind adapters. OpenCode receives the full
 * `<provider>/<id>` upstream model; Codex/Claude receive the bare upstream id via capabilities.
 */
export function defaultCliRunner(request: CliBrokerRequest): Promise<CliTurnResult> {
  const input: CliTransportInput = {
    connection: request.connection,
    model: request.model,
    options: request.options,
    messages: request.messages,
    tools: request.tools,
    signal: request.signal,
    ...(request.environment ? { environment: request.environment } : {}),
    ...(request.fastServiceTierId ? { fastServiceTierId: request.fastServiceTierId } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.onText ? { onText: request.onText } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    ...(request.onUsageSnapshot ? { onUsageSnapshot: request.onUsageSnapshot } : {}),
    ...(request.executable ? { executable: request.executable } : {}),
    ...(request.executableArgs ? { executableArgs: request.executableArgs } : {}),
  };
  if (request.connection.kind === 'opencode-cli') return runOpenCode(request);
  if (request.connection.kind === 'claude-code-cli') return runClaudeCodeCli(input);
  return runCodexCli(input);
}

async function runOpenCode(request: CliBrokerRequest): Promise<CliTurnResult> {
  if (request.credentialMode === 'ferry' && !request.apiKey)
    throw new CliTransportError(
      'authentication',
      'Ferry credential mode requires the selected saved key; refusing to substitute another credential.',
    );
  const result = await runOpenCodeAcp({
    // The OpenCode connection's upstreamId is the full `<provider>/<id>`.
    model: request.model.upstreamId,
    prompt: encodeOpenCodePrompt(request.messages, request.tools),
    tools: request.tools,
    signal: request.signal,
    ...(request.options.effort ? { variant: request.options.effort } : {}),
    speed: request.options.speed,
    ...(request.credentialMode ? { credentialMode: request.credentialMode } : {}),
    ...(request.credentialProvider ? { credentialProvider: request.credentialProvider } : {}),
    ...(request.apiKey ? { apiKey: request.apiKey } : {}),
    ...(request.environment ? { environment: request.environment } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.onText ? { onText: request.onText } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    ...(request.executable ? { executable: request.executable } : {}),
    ...(request.executableArgs ? { executableArgs: request.executableArgs } : {}),
  });
  return {
    text: result.text,
    toolCalls: result.toolCalls,
    usage: result.usage,
    responseModel: result.responseModel,
  };
}

/** Build one CLI `ModelInfo` row from a discovered capability record. */
export function cliModelInfo(connection: CliConnection, model: CliModelCapabilities): ModelInfo {
  // Access truth is per model: any model with its own accumulated receipt is verified, independent of
  // whichever model was verified most recently.
  const verified = isCliModelVerified(connection, model.ref);
  const receipt = connection.verify.modelReceipts?.[model.ref];
  // Never fabricate native capacity: use discovered evidence or an explicit unknown admission state.
  const capacityKnown = model.contextWindow != null && model.maxOutput != null;
  return {
    ref: model.ref,
    providerId: ProviderIdSchema.parse(connection.providerId),
    name: model.name,
    tier: 'T1',
    contextWindow: model.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
    maxOutput: model.maxOutput ?? UNKNOWN_MAX_OUTPUT,
    capacityKnown,
    toolCalling: model.toolCalling,
    reasoning: model.efforts.length > 0,
    reasoningEfforts: knownReasoningEfforts(model),
    // Installed-CLI subscription capacity is never a synthetic free route.
    free: false,
    priceInPerM: null,
    priceOutPerM: null,
    transport: kindTransport[connection.kind],
    cliConnectionId: connection.kind,
    // Preserve the raw discovered tokens and add the explicit unavailable-control reasons.
    cliCapabilities: { ...model, unsupportedEfforts: unsupportedEffortsFor(model) },
    verified,
    verifiedAt: verified ? (receipt?.checkedAt ?? connection.verify.checkedAt) : null,
  };
}

/** Build one CLI `Provider` row from a discovered connection snapshot. */
export function cliProviderInfo(connection: CliConnection): Provider {
  const optedIn = connection.surfaces.native || connection.surfaces.gateway;
  const verified = connection.verify.state === 'verified';
  const health: Provider['health'] =
    connection.account.state === 'signed_out'
      ? 'auth_invalid'
      : connection.verify.state === 'failed'
        ? 'down'
        : verified
          ? 'ok'
          : 'unknown';
  return {
    id: ProviderIdSchema.parse(connection.providerId),
    name: providerNames[connection.kind],
    tag: 'subscription_cli',
    keyRequired: false,
    kind: 'cli',
    brand: null,
    keyStatus: 'not_applicable',
    keyCount: 0,
    enabled: optedIn && verified,
    health,
    cooldownUntil: null,
    dataUse: null,
    termsNote: null,
    signupUrl: null,
    docsUrl: null,
    verifiedAt: null,
    modelCount: connection.models.length,
    availableModels: connection.models.map((model) => cliModelInfo(connection, model)),
    windows: [],
    stepsLeftToday: null,
  };
}

/** A parked caller waiting for the single active generation slot on a connection. */
interface Waiter {
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

interface QueueSlot {
  active: boolean;
  pending: Waiter[];
}

/** True when a billing class never spends real money for a verification generation. */
function isNonSpendingBilling(billing: CliModelCapabilities['billing']): boolean {
  return billing === 'free' || billing === 'included_subscription';
}

/**
 * Core-owned broker for the three installed-CLI connections. It builds the CLI provider/model
 * inventory from cached discovery, serializes one active generation per connection through a small
 * bounded fair queue, and runs the real bounded verification generation. The transport stays a seam
 * so offline tests never spawn a CLI.
 */
export class CliBroker {
  readonly #queues = new Map<CliConnectionKind, QueueSlot>();
  readonly #connectionService: CliConnectionService;
  readonly #services: FerryServices;
  readonly #run: CliTurnRunner;
  /** Existing spending authorization for a metered/unknown-billing verification. Defaults closed. */
  readonly #authorizeSpend: (connection: CliConnection, model: CliModelCapabilities) => boolean;

  constructor(
    services: FerryServices,
    connectionService: CliConnectionService,
    options: {
      runTurn?: CliTurnRunner;
      authorizeSpend?: (connection: CliConnection, model: CliModelCapabilities) => boolean;
    } = {},
  ) {
    this.#services = services;
    this.#connectionService = connectionService;
    this.#run = options.runTurn ?? defaultCliRunner;
    this.#authorizeSpend = options.authorizeSpend ?? (() => false);
  }

  /** Immediate cached connection snapshot with verification receipts revalidated against changes. */
  connections(): CliConnection[] {
    return this.#connectionService.snapshot().map((connection) => this.#revalidate(connection));
  }

  /** CLI provider rows for `providers.list`. Feedback is derived only from cached discovery. */
  providers(): Provider[] {
    return this.connections().map((connection) => cliProviderInfo(connection));
  }

  /** CLI model rows for `models.list`; unverified discovered models stay visible with access state. */
  models(connectionId?: CliConnectionKind): ModelInfo[] {
    return this.connections()
      .filter((connection) => connectionId === undefined || connection.kind === connectionId)
      .flatMap((connection) =>
        connection.models
          .filter((model) => !model.hidden)
          .map((model) => cliModelInfo(connection, model)),
      );
  }

  /** Resolve one discovered model row by ref, or undefined when unknown. */
  model(ref: ModelRef): { connection: CliConnection; model: CliModelCapabilities } | undefined {
    for (const connection of this.connections()) {
      const model = connection.models.find((candidate) => candidate.ref === ref);
      if (model) return { connection, model };
    }
    return undefined;
  }

  /**
   * Run exactly one bounded generation for a connection through the fair queue. Rejects when the
   * connection's backlog is full so a caller can pick another route instead of hanging.
   *
   * The request deadline bounds the total time, queue wait included. It is rejected before the slot
   * is claimed even when the slot is free, and only the remaining budget is passed to the transport,
   * so queue wait plus generation can never exceed the caller's deadline.
   */
  async run(request: CliBrokerRequest): Promise<CliTurnResult> {
    const kind = request.connection.kind;
    const deadlineAt = request.timeoutMs !== undefined ? Date.now() + request.timeoutMs : undefined;
    if (deadlineAt !== undefined && deadlineAt <= Date.now())
      throw new CliTransportError('timeout', `${kind} request deadline already expired`);
    const release = await this.#acquire(kind, request.signal, deadlineAt);
    let bound: { signal: AbortSignal; dispose: () => void } | undefined;
    try {
      request.signal.throwIfAborted();
      const remainingMs = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
      if (remainingMs !== undefined && remainingMs <= 0)
        throw new CliTransportError('timeout', `${kind} request deadline reached before dispatch`);
      bound = this.#bindDeadline(request.signal, remainingMs);
      return await this.#run({
        ...request,
        signal: bound.signal,
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
      });
    } catch (error) {
      throw this.#classify(error, request.connection);
    } finally {
      bound?.dispose();
      release();
    }
  }

  /**
   * Manual dispatch for a pinned installed-CLI model on one surface. Resolves options and enforces
   * the admission policy (surface opt-in, verification, account identity, spending authorization)
   * before the queue, so native and Gateway share exactly one validated path into the transport.
   */
  async dispatch(input: CliDispatchInput): Promise<CliDispatchResult> {
    const resolved = this.model(input.modelRef);
    if (!resolved)
      throw new CliTransportError(
        'unavailable_model',
        `Unknown installed-CLI model: ${input.modelRef}`,
      );
    const { connection, model } = resolved;
    const admission = cliManualAdmission(connection, model, input.surface, {
      authorizeSpend: this.#authorizeSpend,
      ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    });
    if (!admission.ok)
      throw new CliTransportError(
        this.#transportKindForStatus(admission.statusCode),
        admission.message,
        { statusCode: admission.statusCode, accountKey: connection.account.key },
      );
    const connectionModelDefault = this.#connectionModelDefault(connection.kind, model.ref);
    const connectionDefault = this.#connectionDefault(connection.kind);
    const option = resolveCliOption(model, {
      ...(input.profileCliDefault ? { profileDefault: input.profileCliDefault } : {}),
      ...(connectionModelDefault ? { connectionModelDefault } : {}),
      ...(connectionDefault ? { connectionDefault } : {}),
      ...(input.optionOverride ? { conversation: input.optionOverride } : {}),
    });
    // An explicit option the discovered model does not advertise is rejected before any prompt.
    const optionError = cliOptionError(model.ref, model, option);
    if (optionError) throw new CliTransportError('unsupported_capability', optionError);
    const credentialMode = this.#credentialMode(connection.kind);
    const credentialProvider = this.#credentialProvider(connection.kind);
    if (credentialMode === 'ferry' && !input.apiKey)
      throw new CliTransportError(
        'authentication',
        'Ferry credential mode requires the selected saved key; refusing to substitute another credential.',
        { accountKey: connection.account.key },
      );
    const result = await this.run({
      connection,
      model,
      options: option,
      messages: input.messages,
      tools: input.tools,
      signal: input.signal,
      environment: this.#services.env,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      credentialMode,
      ...(credentialProvider ? { credentialProvider } : {}),
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.onText ? { onText: input.onText } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.executable ? { executable: input.executable } : {}),
      ...(input.executableArgs ? { executableArgs: input.executableArgs } : {}),
    });
    return { connection, model, option, result };
  }

  /**
   * Verify one connection by running a single tiny real generation on the selected discovered model.
   * The receipt is bound to the account/version/capability/credential fingerprint so any change
   * invalidates it. Discovery alone never proves access.
   */
  async verify(kind: CliConnectionKind, modelRef?: ModelRef): Promise<CliConnectionVerifyResult> {
    const connection = this.connections().find((entry) => entry.kind === kind);
    if (!connection) return { ok: false, modelRef: null, message: `Unknown connection ${kind}.` };
    const discovered = connection.models.filter((candidate) => !candidate.hidden);
    const requested =
      modelRef === undefined
        ? undefined
        : discovered.find((candidate) => candidate.ref === modelRef);
    if (modelRef !== undefined && !requested)
      return {
        ok: false,
        modelRef,
        message: `Model ${modelRef} is not discovered for ${kind}.`,
      };
    // Prefer a route that cannot spend money. A metered/unknown-billing model is only verified when
    // the caller already holds spending authorization; clicking Verify or an opt-in never approves it.
    const model =
      requested ?? discovered.find((candidate) => isNonSpendingBilling(candidate.billing));
    if (!model)
      return {
        ok: false,
        modelRef: null,
        message: `No free or included-subscription ${kind} model is available to verify without existing spending authorization.`,
      };
    if (!isNonSpendingBilling(model.billing) && !this.#authorizeSpend(connection, model))
      return {
        ok: false,
        modelRef: model.ref,
        message: `Verifying ${model.name} would spend on ${model.billing} billing; existing spending authorization is required and was not supplied.`,
      };
    const credentialMode = this.#credentialMode(connection.kind);
    // Ferry credential mode needs the selected saved key; without it, refuse rather than silently
    // falling back to the anonymous or installed credential.
    if (credentialMode === 'ferry')
      return {
        ok: false,
        modelRef: model.ref,
        message:
          'Ferry credential verification needs a selected saved key; no generation was dispatched and no other credential was substituted.',
      };
    const receiptKey = this.#modelReceiptKey(connection, model);
    const credentialProvider = this.#credentialProvider(connection.kind);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new CliTransportError('timeout', 'CLI verification timed out'));
    }, CLI_VERIFY_TIMEOUT_MS);
    try {
      const result = await this.run({
        connection,
        model,
        options: { effort: null, speed: 'standard' },
        messages: [{ role: 'user', content: 'Reply with exactly Ready. Do not use any tools.' }],
        tools: [],
        signal: controller.signal,
        environment: this.#services.env,
        timeoutMs: CLI_VERIFY_TIMEOUT_MS,
        credentialMode,
        ...(credentialProvider ? { credentialProvider } : {}),
      });
      if (!result.text.trim())
        throw new CliTransportError('provider_error', 'The CLI returned no text for verification');
      // A credential/account change during the run invalidates the receipt it would have set.
      const current = this.connections().find((entry) => entry.kind === kind);
      if (!current || this.#modelReceiptKey(current, model) !== receiptKey)
        return {
          ok: false,
          modelRef: model.ref,
          message: 'The CLI credential or account changed during verification. Check it again.',
        };
      const checkedAt = new Date().toISOString();
      // Accumulate: a successful check of a new model never forgets earlier verified models.
      const modelReceipts: Record<ModelRef, CliModelReceipt> = {
        ...(current.verify.modelReceipts ?? {}),
        [model.ref]: { checkedAt, receiptKey },
      };
      this.#connectionService.applyVerification(kind, {
        state: 'verified',
        modelRef: model.ref,
        checkedAt,
        message: `Verified with a real generation on ${model.name}.`,
        receiptKey,
        modelReceipts,
      });
      return {
        ok: true,
        modelRef: model.ref,
        message: `Verified ${model.name} with a real generation.`,
      };
    } catch (error) {
      const message =
        error instanceof CliTransportError
          ? error.message
          : redactKnownSecretText(error instanceof Error ? error.message : 'Verification failed');
      // A failed check of a new model must not disable already-verified models: keep their receipts
      // and the verified summary, only reporting the failure through the result message.
      const current = this.connections().find((entry) => entry.kind === kind) ?? connection;
      const priorReceipts = current.verify.modelReceipts ?? {};
      const hasPrior = Object.keys(priorReceipts).length > 0;
      this.#connectionService.applyVerification(
        kind,
        hasPrior
          ? {
              state: 'verified',
              modelRef: current.verify.modelRef,
              checkedAt: current.verify.checkedAt,
              message,
              receiptKey: current.verify.receiptKey ?? null,
              modelReceipts: priorReceipts,
            }
          : {
              state: 'failed',
              modelRef: model.ref,
              checkedAt: new Date().toISOString(),
              message,
              receiptKey: null,
            },
      );
      return { ok: false, modelRef: model.ref, message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve the credential mode the current settings select (OpenCode specific; others installed). */
  #credentialMode(kind: CliConnectionKind): 'installed' | 'anonymous' | 'ferry' {
    if (kind !== 'opencode-cli') return 'installed';
    const stored = this.#services.settings.get('global') as
      { cliConnections?: Record<string, { credentialMode?: unknown }> } | undefined;
    const value = stored?.cliConnections?.[kind]?.credentialMode;
    return value === 'anonymous' || value === 'ferry' ? value : 'installed';
  }

  #credentialProvider(kind: CliConnectionKind): string | null {
    if (kind !== 'opencode-cli') return null;
    const stored = this.#services.settings.get('global') as
      { cliConnections?: Record<string, { credentialProvider?: unknown }> } | undefined;
    const value = stored?.cliConnections?.[kind]?.credentialProvider;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  /**
   * Nonsecret fingerprint of the account identity, installed version, credential selection and one
   * model's effective capabilities. A per-model receipt is invalidated only by evidence that
   * actually bears on that model, so verifying another model never stales it. Never includes key
   * material.
   */
  #modelReceiptKey(connection: CliConnection, model: CliModelCapabilities): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          connection.account.key,
          connection.install.version,
          model.ref,
          model.efforts,
          model.speeds,
          model.contextWindow,
          model.maxOutput,
          model.billing,
          this.#credentialMode(connection.kind),
          this.#credentialProvider(connection.kind),
        ]),
      )
      .digest('hex');
  }

  /** Legacy whole-connection fingerprint used only to revalidate receipts written before per-model evidence. */
  #legacyReceiptKey(connection: CliConnection): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          connection.account.key,
          connection.install.version,
          connection.models.map((model) => [
            model.ref,
            model.efforts,
            model.speeds,
            model.contextWindow,
            model.maxOutput,
          ]),
          this.#credentialMode(connection.kind),
          this.#credentialProvider(connection.kind),
        ]),
      )
      .digest('hex');
  }

  /**
   * Revalidate persisted receipts against the current evidence. Accumulated per-model receipts whose
   * bound fingerprint still matches are retained (so a connection with several verified models keeps
   * them all); receipts whose evidence changed, and legacy receipts with a mismatched whole-connection
   * fingerprint, are dropped. If nothing survives, the summary is downgraded to stale conservatively.
   */
  #revalidate(connection: CliConnection): CliConnection {
    if (connection.verify.state !== 'verified') return connection;
    if (connection.verify.modelReceipts) {
      const kept: Record<ModelRef, CliModelReceipt> = {};
      for (const [ref, receipt] of Object.entries(connection.verify.modelReceipts)) {
        const model = connection.models.find((candidate) => candidate.ref === ref);
        if (
          model &&
          receipt.receiptKey != null &&
          receipt.receiptKey === this.#modelReceiptKey(connection, model)
        )
          kept[ref as ModelRef] = receipt;
      }
      if (Object.keys(kept).length > 0) {
        return { ...connection, verify: { ...connection.verify, modelReceipts: kept } };
      }
    } else if (
      connection.verify.receiptKey != null &&
      connection.verify.receiptKey === this.#legacyReceiptKey(connection)
    ) {
      return connection;
    }
    const verify: CliConnection['verify'] = {
      state: 'stale',
      modelRef: connection.verify.modelRef,
      checkedAt: connection.verify.checkedAt,
      message:
        connection.verify.receiptKey == null && connection.verify.modelReceipts == null
          ? 'This verification has no bound evidence; verify again.'
          : 'The CLI account, version, capabilities or credential changed since this was verified.',
      receiptKey: null,
    };
    this.#connectionService.applyVerification(connection.kind, verify);
    return { ...connection, verify };
  }

  /** Read the persisted connection default options for one kind (`cliConnections[kind]`). */
  #connectionDefault(kind: CliConnectionKind): CliOption | undefined {
    const stored = this.#services.settings.get('global') as
      { cliConnections?: Record<string, { defaultOptions?: CliOption }> } | undefined;
    return stored?.cliConnections?.[kind]?.defaultOptions;
  }

  #connectionModelDefault(kind: CliConnectionKind, ref: ModelRef): CliOptionLayer | undefined {
    const stored = this.#services.settings.get('global') as
      | {
          cliConnections?: Record<string, { modelDefaults?: Record<string, CliOptionLayer> }>;
        }
      | undefined;
    // Return the raw partial so an absent field inherits instead of materializing a null/standard.
    return stored?.cliConnections?.[kind]?.modelDefaults?.[ref];
  }

  #transportKindForStatus(status: number): CliTransportErrorKind {
    if (status === 401 || status === 403) return 'authentication';
    if (status === 402) return 'unsupported_capability';
    if (status === 429) return 'temporary_rate_limit';
    return 'unsupported_capability';
  }

  /**
   * Link the caller signal to a remaining-time budget. Passes a child signal to the transport and
   * aborts it with a normalized timeout error when the budget elapses. `dispose` always clears the
   * timer, so a fast turn never leaks a live deadline.
   */
  #bindDeadline(
    parent: AbortSignal,
    remainingMs: number | undefined,
  ): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const forward = () => {
      controller.abort(parent.reason);
    };
    if (parent.aborted) forward();
    else parent.addEventListener('abort', forward, { once: true });
    let timer: NodeJS.Timeout | undefined;
    if (remainingMs !== undefined)
      timer = setTimeout(
        () => {
          controller.abort(new CliTransportError('timeout', 'CLI request deadline reached'));
        },
        Math.max(0, remainingMs),
      );
    return {
      signal: controller.signal,
      dispose: () => {
        parent.removeEventListener('abort', forward);
        if (timer) clearTimeout(timer);
      },
    };
  }

  #classify(error: unknown, connection: CliConnection): CliTransportError {
    if (isCliTransportError(error)) return error;
    // OpenCode throws its own structured error; normalize it to the shared transport kinds so the
    // caller keeps the account, quota reset and status instead of a generic provider error.
    if (isOpenCodeAcpError(error))
      return new CliTransportError(
        normalizeOpenCodeCategory(error.category, error.message, error.statusCode),
        error.message,
        {
          ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
          accountKey: connection.account.key,
          resetAt: error.resetAt,
        },
      );
    const message = error instanceof Error ? error.message : String(error);
    // A native/caller abort is a cancellation, not a provider failure.
    if (isAbortLikeError(error))
      return new CliTransportError('cancelled', 'CLI generation was cancelled', {
        accountKey: connection.account.key,
      });
    if (connection.account.state === 'signed_out')
      return new CliTransportError('authentication', `${connection.kind} is not signed in`, {
        accountKey: connection.account.key,
      });
    return new CliTransportError('provider_error', redactKnownSecretText(message), {
      accountKey: connection.account.key,
    });
  }

  /**
   * Claim the single generation slot for a connection. When another generation is active the caller
   * is parked FIFO until the slot frees. Parking honours the caller's abort signal and the request
   * deadline: an aborted or expired waiter is removed immediately and rejects without touching the
   * active slot, so it settles promptly even when the active transport ignores cancellation.
   */
  async #acquire(
    kind: CliConnectionKind,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<() => void> {
    signal.throwIfAborted();
    let slot = this.#queues.get(kind);
    if (!slot) {
      slot = { active: false, pending: [] };
      this.#queues.set(kind, slot);
    }
    const activeSlot: QueueSlot = slot;
    if (!activeSlot.active) {
      activeSlot.active = true;
      return () => {
        this.#release(kind, activeSlot);
      };
    }
    if (activeSlot.pending.length >= CLI_QUEUE_LIMIT)
      throw new CliTransportError(
        'temporary_rate_limit',
        `${kind} already has the maximum number of queued generations`,
      );
    if (deadlineAt !== undefined && deadlineAt <= Date.now())
      throw new CliTransportError('timeout', `${kind} queue wait exceeded the request deadline`);
    return new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        settled: false,
        resolve,
        reject,
        cleanup: () => {
          signal.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
        },
      };
      const settleReject = (error: CliTransportError) => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = activeSlot.pending.indexOf(waiter);
        // Remove only this waiter; never release the slot someone else holds.
        if (index >= 0) activeSlot.pending.splice(index, 1);
        waiter.cleanup();
        waiter.reject(error);
      };
      const onAbort = () => {
        settleReject(
          new CliTransportError('cancelled', `${kind} generation was cancelled while queued`),
        );
      };
      if (deadlineAt !== undefined)
        timer = setTimeout(
          () => {
            settleReject(
              new CliTransportError('timeout', `${kind} queue wait exceeded the request deadline`),
            );
          },
          Math.max(0, deadlineAt - Date.now()),
        );
      signal.addEventListener('abort', onAbort, { once: true });
      activeSlot.pending.push(waiter);
    });
  }

  #release(kind: CliConnectionKind, slot: QueueSlot): void {
    const next = slot.pending.shift();
    if (next && !next.settled) {
      next.settled = true;
      next.cleanup();
      next.resolve(() => {
        this.#release(kind, slot);
      });
    } else if (next) {
      // A settled waiter should already have been removed; skip to the next in line.
      this.#release(kind, slot);
    } else slot.active = false;
  }
}

const brokerIndex = new WeakMap<FerryServices, CliBroker>();

/** Lazily construct the per-services CLI broker sharing the cached connection service. */
export function getCliBroker(
  services: FerryServices,
  emit: (method: string, payload: unknown) => void,
): CliBroker {
  let broker = brokerIndex.get(services);
  if (!broker) {
    broker = new CliBroker(
      services,
      getCliConnectionService(services, emit),
      services.cliRunTurn ? { runTurn: services.cliRunTurn } : {},
    );
    brokerIndex.set(services, broker);
  }
  return broker;
}

/**
 * Build the immediate CLI provider/model inventory from a cached connection snapshot, without a
 * broker queue. Pure mapping used by coordinators that already hold the cached snapshot.
 */
export function cliInventorySnapshot(connections: readonly CliConnection[]): {
  providers: Provider[];
  models: ModelInfo[];
} {
  return {
    providers: connections.map((connection) => cliProviderInfo(connection)),
    models: connections.flatMap((connection) =>
      connection.models
        .filter((model) => !model.hidden)
        .map((model) => cliModelInfo(connection, model)),
    ),
  };
}
