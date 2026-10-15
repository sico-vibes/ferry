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
  type Profile,
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
import {
  bindCliEmit,
  getCliConnectionService,
  type CliConnectionService,
} from './cli-connections.js';
import { resolveOpenCodeCredential } from './cli-opencode-credentials.js';
import {
  CliCapacityGuard,
  parseCliCapacityBlocks,
  type CliCapacityBlock,
  type CliCapacityIdentity,
  type CliCapacityStore,
} from './cli-capacity-guard.js';

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
  /**
   * Capacity identity recorded against a typed transport failure and re-checked after a queue wait.
   * Internal admission plumbing; never set by the transport.
   */
  capacityIdentity?: CliCapacityIdentity;
  /** Re-run admission (guard + credential) once this caller owns the connection slot. */
  revalidate?: () => Promise<void>;
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
  /**
   * Opaque, non-secret account fingerprint of the credential actually selected for this generation,
   * captured *before* the await. Never a raw key; `null` when no stable API-key identity exists.
   */
  accountKey: string | null;
  /** Actual upstream provider of the selected model (`opencode`/`opencode-go`), or `null`. */
  provider: string | null;
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
 * Output placeholder used only when the CLI never reported a real output limit. It is inert whenever
 * `capacityKnown` is false; no native model capacity is invented. Unknown *context* uses the explicit
 * transport policy bound (below) rather than a fabricated small window, so the preflight/context
 * budget admits realistic Ferry prompts instead of rejecting them against a fake 8K native limit.
 */
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
    /**
     * Effective credential mode for this request. Anonymous OpenCode access is only eligible for a
     * free Zen model and needs no signed-in account key; every other mode needs a real account.
     */
    credentialMode?: 'installed' | 'anonymous' | 'ferry';
    /**
     * Actual resolved upstream provider of the selected model. A genuinely free OpenCode Zen model
     * reached through its own Zen source is admitted without a signed-in account key (keyless
     * installed/anonymous native access); a Go/other upstream or an included model is not.
     */
    credentialProvider?: string | null;
    /** Effective resolved speed. A possibly separately billed `fast` requires spending authorization. */
    speed?: 'standard' | 'fast';
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
  // A genuinely free OpenCode Zen model resolved through its own Zen source is admitted keyless
  // (anonymous, or installed without a Zen key). An included/third-party upstream or a Go account
  // never satisfies this exemption.
  const keylessZenFree =
    model.billing === 'free' &&
    options.credentialProvider === 'opencode' &&
    model.upstreamProvider === 'opencode';
  if (
    !keylessZenFree &&
    (connection.account.state !== 'signed_in' || connection.account.key === null)
  )
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
  // A possibly separately billed `fast` mode is never authorized by a Native/Included/free label
  // alone. The discovery schema carries no separate evidence that `fast` itself is free, so *any*
  // `fast` dispatch requires existing monetary authorization rather than an implicit zero-cost
  // assumption; a free *standard* generation stays non-spending.
  const fastNeedsSpend = options.speed === 'fast';
  if (!isNonSpendingBilling(model.billing) || fastNeedsSpend) {
    if (!options.authorizeSpend?.(connection, model))
      return {
        ok: false,
        statusCode: 402,
        message: fastNeedsSpend
          ? `${model.name} fast mode may be billed separately; dispatching it needs an existing monetary spending authorization. No zero-cost charge was assumed.`
          : `${model.name} is billed as ${model.billing}; dispatching it needs an existing monetary spending authorization and a known price budget. No zero-cost charge was assumed.`,
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
    // A subscription CLI route is a general-purpose coding tier, not an API "cheap/small" T1: the
    // built-in profiles' `tierByStep` maps plan/edit to T2/T3, so a T1 label would make every
    // installed-CLI route invisible to Auto for the primary step.
    tier: 'T2',
    // A real discovered context window is used verbatim; when the CLI never reported one, the value
    // is the explicit transport policy bound (not native capacity evidence), and `capacityKnown`
    // stays false so the UI shows "Not reported" rather than claiming a native window.
    contextWindow: model.contextWindow ?? MANUAL_UNKNOWN_CAPACITY_INPUT_BOUND,
    maxOutput: model.maxOutput ?? UNKNOWN_MAX_OUTPUT,
    capacityKnown,
    toolCalling: model.toolCalling,
    reasoning: model.efforts.length > 0,
    reasoningEfforts: knownReasoningEfforts(model),
    // `free` reflects the actual discovered billing class: only a genuinely zero-cost model is free.
    // An included subscription (e.g. OpenCode Go) and metered/unknown billing are never `free`.
    free: model.billing === 'free',
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
/** Resolved, non-secret credential identity for one dispatch/verify. Never persisted wholesale. */
interface ResolvedCliCredential {
  mode: 'installed' | 'anonymous' | 'ferry';
  provider: string | null;
  credentialProvider: string | null;
  accountKey: string | null;
  /** Memory-only secret; populated only when Ferry supplies the credential itself. */
  apiKey?: string;
}

/** Persisted capacity blocks live under a dedicated settings key and are validated on read. */
function createCapacityStore(services: FerryServices): CliCapacityStore {
  return {
    load: () => parseCliCapacityBlocks(services.settings.get('cli-capacity')),
    save: (blocks) => {
      services.settings.put('cli-capacity', blocks);
    },
  };
}

export class CliBroker {
  readonly #queues = new Map<CliConnectionKind, QueueSlot>();
  readonly #connectionService: CliConnectionService;
  readonly #services: FerryServices;
  readonly #run: CliTurnRunner;
  /** Existing spending authorization for a metered/unknown-billing verification. Defaults closed. */
  readonly #authorizeSpend: (connection: CliConnection, model: CliModelCapabilities) => boolean;
  /** Persistent, identity-scoped capacity circuit guard shared by native and Gateway dispatch. */
  readonly #capacity: CliCapacityGuard;
  /** Last-seen account fingerprint per (connection, upstream) scope, for correct-scope clearing. */
  readonly #accountScopes = new Map<string, string | null>();

  constructor(
    services: FerryServices,
    connectionService: CliConnectionService,
    options: {
      runTurn?: CliTurnRunner;
      authorizeSpend?: (connection: CliConnection, model: CliModelCapabilities) => boolean;
      /** Injectable capacity storage (tests); defaults to the persisted settings block. */
      capacityStore?: CliCapacityStore;
    } = {},
  ) {
    this.#services = services;
    this.#connectionService = connectionService;
    this.#run = options.runTurn ?? defaultCliRunner;
    this.#authorizeSpend = options.authorizeSpend ?? (() => false);
    this.#capacity = new CliCapacityGuard({
      now: () => services.clock.now().getTime(),
      store: options.capacityStore ?? createCapacityStore(services),
    });
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

  /**
   * Shared funding-eligibility pool for installed-CLI routing (native Auto and, when its owner wires
   * it, Gateway Auto). A row is eligible only when the target surface is opted in, the exact model
   * carries a successful verification receipt, its effective capability/options are compatible, and
   * its *actual billing* is fundable: genuinely free models always, included-subscription models only
   * when the profile opts in via `allowSubscriptionCli`. Metered/unknown models are never in the pool
   * — they need an explicit bounded monetary authorization at manual dispatch. Free routes are ranked
   * ahead of included ones independent of the quality preset.
   */
  eligibleModels(query: {
    surface: 'native' | 'gateway';
    profile: Profile;
    requiresTools?: boolean;
    inputTokens?: number;
  }): ModelInfo[] {
    const allowedRefs = query.profile.allowedModelRefs
      ? new Set<string>(query.profile.allowedModelRefs)
      : null;
    const allowedProviders = Array.isArray(query.profile.allowedProviders)
      ? new Set<string>(query.profile.allowedProviders)
      : null;
    const free: ModelInfo[] = [];
    const included: ModelInfo[] = [];
    for (const connection of this.connections()) {
      if (!connection.surfaces[query.surface]) continue;
      if (allowedProviders && !allowedProviders.has(connection.providerId)) continue;
      // Never offer capacity the account window already reports exhausted; the guard still blocks at
      // dispatch for the actually-resolved identity, but Auto should not waste a step on it.
      if (this.#exhaustedAccountWindow(connection)) continue;
      const connectionDefault = this.#connectionDefault(connection.kind);
      for (const model of connection.models) {
        if (model.hidden) continue;
        if (allowedRefs && !allowedRefs.has(model.ref)) continue;
        if (!isCliModelVerified(connection, model.ref)) continue;
        if (query.requiresTools && !model.toolCalling) continue;
        if (
          query.inputTokens !== undefined &&
          model.contextWindow != null &&
          query.inputTokens > model.contextWindow
        )
          continue;
        // The effective option (profile + connection model/default layers; Auto has no conversation
        // override) must be one the discovered model actually advertises. `fast` is never assumed
        // authorized for automatic routing, and an unsupported configured effort/control excludes
        // the model rather than dispatching an option the CLI cannot run.
        const modelDefault = this.#connectionModelDefault(connection.kind, model.ref);
        const option = resolveCliOption(model, {
          ...(query.profile.cliDefaults?.[model.ref]
            ? { profileDefault: query.profile.cliDefaults[model.ref] }
            : {}),
          ...(modelDefault ? { connectionModelDefault: modelDefault } : {}),
          ...(connectionDefault ? { connectionDefault } : {}),
        });
        if (option.speed === 'fast') continue;
        if (cliOptionError(model.ref, model, option)) continue;
        if (model.billing === 'free') free.push(cliModelInfo(connection, model));
        else if (
          model.billing === 'included_subscription' &&
          query.profile.allowSubscriptionCli === true
        )
          included.push(cliModelInfo(connection, model));
      }
    }
    return [...free, ...included];
  }

  /**
   * Selectable installed-CLI models for a surface: opted-in, verified and (optionally) tool-capable,
   * regardless of funding. This is the manual picker pool (a user may explicitly pin an included or
   * metered model, which dispatch then authorizes); free routes are ranked first. Auto routing uses
   * `eligibleModels` instead, which additionally requires fundable billing.
   */
  selectableModels(
    surface: 'native' | 'gateway',
    options: { requiresTools?: boolean } = {},
  ): ModelInfo[] {
    const free: ModelInfo[] = [];
    const rest: ModelInfo[] = [];
    for (const connection of this.connections()) {
      if (!connection.surfaces[surface]) continue;
      for (const model of connection.models) {
        if (model.hidden) continue;
        if (!isCliModelVerified(connection, model.ref)) continue;
        if (options.requiresTools && !model.toolCalling) continue;
        const info = cliModelInfo(connection, model);
        (model.billing === 'free' ? free : rest).push(info);
      }
    }
    return [...free, ...rest];
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
      // Admission recheck after the queue wait: a profile/credential/account change while parked must
      // never dispatch against stale evidence. Runs only once this caller owns the connection slot.
      if (request.revalidate) await request.revalidate();
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
      const classified = this.#classify(error, request.connection);
      if (request.capacityIdentity) this.#recordCapacity(request.capacityIdentity, classified);
      throw classified;
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
    // Resolve the actual selected credential (provider-specific fingerprint) before any dispatch, and
    // validate it against the stored verification receipt plus the account-window/guard admission.
    const credential = await this.#resolveCredential(connection, model, input.apiKey);
    const option = this.#resolveDispatchOption(input, connection, model);
    // An explicit option the discovered model does not advertise is rejected before any prompt.
    const optionError = cliOptionError(model.ref, model, option);
    if (optionError) throw new CliTransportError('unsupported_capability', optionError);
    // Admission (surface opt-in, verification, account identity, billing/fast authorization) is the
    // outer gate; the receipt-evidence and account-window/guard checks refine it afterwards.
    const admission = cliManualAdmission(connection, model, input.surface, {
      authorizeSpend: this.#authorizeSpend,
      credentialMode: credential.mode,
      credentialProvider: credential.provider,
      speed: option.speed,
      ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    });
    if (!admission.ok)
      throw new CliTransportError(
        this.#transportKindForStatus(admission.statusCode),
        admission.message,
        { statusCode: admission.statusCode, accountKey: credential.accountKey },
      );
    this.#assertReceiptEvidence(connection, model, credential);
    this.#assertAdmissible(connection, model, credential);
    const identity = this.#capacityIdentity(connection, model, credential);
    const capturedDigest = this.#admissionDigest(connection, model, credential, option);
    // Re-check the *current* shared state after the queue wait: surface opt-in, proof, credential
    // evidence, effective options, account windows and the guard. Any change rejects before the
    // runner, so a parked caller never runs a stale key/source/model.
    const revalidate = async () => {
      const current = this.model(input.modelRef);
      if (!current)
        throw new CliTransportError(
          'unavailable_model',
          `The installed-CLI model ${input.modelRef} is no longer available. Send again.`,
        );
      const freshConnection = current.connection;
      const freshModel = current.model;
      if (!freshConnection.surfaces[input.surface])
        throw new CliTransportError(
          'unsupported_capability',
          `${freshConnection.kind} was opted out of the ${input.surface} surface while this request was queued.`,
        );
      if (!isCliModelVerified(freshConnection, freshModel.ref))
        throw new CliTransportError(
          'authentication',
          `${freshModel.name} is no longer verified for this credential. Run Verify again.`,
        );
      const fresh = await this.#resolveCredential(freshConnection, freshModel, input.apiKey);
      this.#assertReceiptEvidence(freshConnection, freshModel, fresh);
      if (fresh.accountKey !== credential.accountKey)
        throw new CliTransportError(
          'authentication',
          'The CLI credential changed while this request was queued. Send again with the current credential.',
          { accountKey: fresh.accountKey },
        );
      const freshOption = this.#resolveDispatchOption(input, freshConnection, freshModel);
      const freshError = cliOptionError(freshModel.ref, freshModel, freshOption);
      if (freshError) throw new CliTransportError('unsupported_capability', freshError);
      if (this.#admissionDigest(freshConnection, freshModel, fresh, freshOption) !== capturedDigest)
        throw new CliTransportError(
          'authentication',
          'The CLI route changed while this request was queued. Send again.',
        );
      this.#assertAdmissible(freshConnection, freshModel, fresh);
    };
    const result = await this.run({
      connection,
      model,
      options: option,
      messages: input.messages,
      tools: input.tools,
      signal: input.signal,
      environment: this.#services.env,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      credentialMode: credential.mode,
      ...(credential.credentialProvider
        ? { credentialProvider: credential.credentialProvider }
        : {}),
      ...(credential.apiKey !== undefined
        ? { apiKey: credential.apiKey }
        : input.apiKey
          ? { apiKey: input.apiKey }
          : {}),
      capacityIdentity: identity,
      revalidate,
      onUsageSnapshot: (snapshot) => {
        this.#connectionService.applyUsage(connection.kind, snapshot);
      },
      ...(input.onText ? { onText: input.onText } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.executable ? { executable: input.executable } : {}),
      ...(input.executableArgs ? { executableArgs: input.executableArgs } : {}),
    });
    return {
      connection,
      model,
      option,
      result,
      accountKey: credential.accountKey,
      provider: credential.provider,
    };
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
    // Resolve the actual selected credential before dispatching the verification generation. A ferry
    // mode with no saved key (or an unsupported cross-provider offer) rejects here with a typed,
    // redacted error rather than silently substituting another credential.
    let credential: ResolvedCliCredential;
    try {
      credential = await this.#resolveCredential(connection, model);
    } catch (error) {
      return {
        ok: false,
        modelRef: model.ref,
        message:
          error instanceof Error
            ? redactKnownSecretText(error.message)
            : 'The credential could not be resolved; no generation was dispatched.',
      };
    }
    const identity = this.#capacityIdentity(connection, model, credential);
    this.#syncCapacityAccount(connection.kind, identity);
    // A currently known-exhausted included account window blocks even Verify, so verification is not
    // a back door that silently consumes overage/credits. The guard's unknown-reset block is NOT
    // applied here: with no snapshot evidence, an explicit real generation is the successful check
    // that clears it. A failure is still recorded by `run`.
    try {
      this.#assertAccountCapacity(connection, model);
    } catch (error) {
      return {
        ok: false,
        modelRef: model.ref,
        message:
          error instanceof Error
            ? redactKnownSecretText(error.message)
            : 'The account window is exhausted; no generation was dispatched.',
      };
    }
    const receiptKey = this.#modelReceiptKey(connection, model);
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
        credentialMode: credential.mode,
        ...(credential.credentialProvider
          ? { credentialProvider: credential.credentialProvider }
          : {}),
        ...(credential.apiKey !== undefined ? { apiKey: credential.apiKey } : {}),
        capacityIdentity: identity,
      });
      if (!result.text.trim())
        throw new CliTransportError('provider_error', 'The CLI returned no text for verification');
      // A credential/account/capability change during the run invalidates the receipt it would have
      // set. Both the synchronous cache key and the freshly resolved credential evidence are checked.
      const current = this.connections().find((entry) => entry.kind === kind);
      if (!current || this.#modelReceiptKey(current, model) !== receiptKey)
        return {
          ok: false,
          modelRef: model.ref,
          message: 'The CLI credential or account changed during verification. Check it again.',
        };
      const after = await this.#resolveCredential(current, model).catch(() => null);
      if (after?.accountKey !== credential.accountKey)
        return {
          ok: false,
          modelRef: model.ref,
          message: 'The CLI credential or account changed during verification. Check it again.',
        };
      // A successful real generation is an explicit successful check: clear this scope's exhausted
      // block (unknown-reset exhaustion only unblocks on a real success or account change).
      this.#capacity.verifiedRefresh(identity);
      const checkedAt = new Date().toISOString();
      // Accumulate: a successful check of a new model never forgets earlier verified models. Each
      // receipt binds the actual resolved credential fingerprint for that model's own upstream.
      const modelReceipts: Record<ModelRef, CliModelReceipt> = {
        ...(current.verify.modelReceipts ?? {}),
        [model.ref]: { checkedAt, receiptKey, credentialKey: credential.accountKey },
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

  /**
   * Resolve the actual selected credential identity before verify/dispatch. For a real OpenCode
   * model (one that reports an upstream provider) this delegates to the reviewed provider-specific
   * resolver, so Zen, Go and any other provider keep independent fingerprints. Codex/Claude always
   * use their installed sign-in; an OpenCode model that reports no upstream provider falls back to
   * the stored connection selection so legacy/undiscovered fixtures stay dispatchable.
   */
  async #resolveCredential(
    connection: CliConnection,
    model: CliModelCapabilities,
    fallbackApiKey?: string,
  ): Promise<ResolvedCliCredential> {
    if (connection.kind !== 'opencode-cli')
      return {
        mode: 'installed',
        provider: null,
        credentialProvider: null,
        accountKey: connection.account.key,
      };
    const provider = model.upstreamProvider?.trim() ?? '';
    if (provider) {
      // Anonymous/Ferry modes and the Go offer are Zen-specific preferences. A non-Zen upstream
      // (e.g. OpenCode Go) keeps its own installed source, so resolve it as `installed` instead of
      // letting a Zen-only preference reject or mis-attribute that provider's credential.
      const mode = this.#credentialMode('opencode-cli');
      const offer = this.#credentialProvider('opencode-cli');
      const zenSpecific =
        provider !== 'opencode' && (mode !== 'installed' || (offer !== null && offer !== provider));
      const evidence = await resolveOpenCodeCredential(
        zenSpecific ? this.#installedView() : this.#services,
        model,
      );
      return {
        mode: evidence.mode,
        provider: evidence.provider,
        credentialProvider: evidence.credentialProvider,
        accountKey: evidence.accountKey,
        ...(evidence.apiKey !== undefined ? { apiKey: evidence.apiKey } : {}),
      };
    }
    const mode = this.#credentialMode('opencode-cli');
    const credentialProvider = this.#credentialProvider('opencode-cli');
    if (mode === 'ferry' && !fallbackApiKey)
      throw new CliTransportError(
        'authentication',
        'Ferry credential mode requires the selected saved key; refusing to substitute another credential.',
        { accountKey: connection.account.key },
      );
    return {
      mode,
      provider: null,
      credentialProvider,
      accountKey: connection.account.key,
      ...(fallbackApiKey ? { apiKey: fallbackApiKey } : {}),
    };
  }

  /**
   * A read-through settings view that forces the OpenCode connection selection to `installed`, used
   * to resolve a non-Zen upstream's own installed credential without editing the shared resolver.
   */
  #installedView(): FerryServices {
    const settings = this.#services.settings;
    const global = settings.get('global');
    if (typeof global !== 'object' || global === null) return this.#services;
    const record = (global as { cliConnections?: Record<string, unknown> }).cliConnections?.[
      'opencode-cli'
    ];
    const cliConnections = {
      ...(global as { cliConnections?: Record<string, unknown> }).cliConnections,
      'opencode-cli': {
        ...(typeof record === 'object' && record !== null ? record : {}),
        credentialMode: 'installed',
        credentialProvider: null,
      },
    };
    const overridden = { ...(global as Record<string, unknown>), cliConnections };
    return {
      ...this.#services,
      settings: {
        get: (key: string) => (key === 'global' ? overridden : settings.get(key)),
        put: settings.put.bind(settings),
      },
    } as unknown as FerryServices;
  }

  /**
   * Reject a dispatch/verify when the model's stored verification receipt is not bound to the
   * currently resolved credential evidence (or is not evidence-bound at all). This is the
   * synchronous-safe half of receipt validation: the cached list stays fast, and the actual selected
   * evidence is compared here before every generation.
   */
  #assertReceiptEvidence(
    connection: CliConnection,
    model: CliModelCapabilities,
    credential: ResolvedCliCredential,
  ): void {
    const receipt = connection.verify.modelReceipts?.[model.ref];
    if (receipt?.credentialKey === undefined)
      throw new CliTransportError(
        'authentication',
        `${model.name} was verified without a bound credential fingerprint. Run Verify for this model again before sending.`,
        { accountKey: credential.accountKey },
      );
    // A `null` bound key means "no stable API-key identity" (native OAuth/unknown); two nulls match.
    if (receipt.credentialKey !== credential.accountKey)
      throw new CliTransportError(
        'authentication',
        `The credential or account for ${model.name} changed since it was verified. Run Verify again; no stale credential was used.`,
        { accountKey: credential.accountKey },
      );
  }

  /**
   * Block a known-exhausted *included* account window before any generation (Verify included). Only a
   * usable snapshot with a genuinely exhausted window blocks; an unavailable/unknown snapshot never
   * invents exhaustion, and a free model (e.g. anonymous Zen) is unrelated to the account window.
   */
  /**
   * The known-exhausted account window for this connection, or null. A snapshot bound to a different
   * account never matches; an elapsed window is superseded at its own reported reset (the persistent
   * guard expires at the same instant), so a stale zero snapshot cannot reblock forever and no new
   * future reset is invented.
   */
  #exhaustedAccountWindow(
    connection: CliConnection,
  ): CliConnection['usage']['windows'][number] | null {
    const usage = connection.usage;
    if (usage.state === 'unavailable') return null;
    if (usage.accountKey !== null && usage.accountKey !== connection.account.key) return null;
    const nowMs = this.#services.clock.now().getTime();
    return (
      usage.windows.find((window) => {
        const usedUp =
          (window.utilization !== null && window.utilization >= 1) ||
          (window.remaining !== null && window.remaining <= 0);
        if (!usedUp) return false;
        const resetMs = window.resetAt === null ? null : Date.parse(window.resetAt);
        if (resetMs !== null && Number.isFinite(resetMs) && nowMs >= resetMs) return false;
        return true;
      }) ?? null
    );
  }

  #assertAccountCapacity(connection: CliConnection, model: CliModelCapabilities): void {
    if (model.billing !== 'included_subscription') return;
    const exhausted = this.#exhaustedAccountWindow(connection);
    if (!exhausted) return;
    throw new CliTransportError(
      'exhausted_capacity',
      `${model.name} is blocked: the ${connection.kind} account window "${exhausted.label}" is exhausted${exhausted.resetAt ? ` and resets at ${exhausted.resetAt}` : ''}. Refreshing usage with new usable evidence is required; the transport did not consume overage or credits.`,
      { resetAt: exhausted.resetAt, accountKey: connection.account.key },
    );
  }

  /** Resolve the effective CLI option for a dispatch from the current connection/profile layers. */
  #resolveDispatchOption(
    input: CliDispatchInput,
    connection: CliConnection,
    model: CliModelCapabilities,
  ): CliOption {
    const connectionModelDefault = this.#connectionModelDefault(connection.kind, model.ref);
    const connectionDefault = this.#connectionDefault(connection.kind);
    return resolveCliOption(model, {
      ...(input.profileCliDefault ? { profileDefault: input.profileCliDefault } : {}),
      ...(connectionModelDefault ? { connectionModelDefault } : {}),
      ...(connectionDefault ? { connectionDefault } : {}),
      ...(input.optionOverride ? { conversation: input.optionOverride } : {}),
    });
  }

  /**
   * Nonsecret digest of the structural admission identity for one dispatch: model/upstream,
   * synchronous receipt evidence, effective option and resolved credential. Comparing the digest
   * before and after a queue wait rejects any opt-out/capability/option/credential change.
   */
  #admissionDigest(
    connection: CliConnection,
    model: CliModelCapabilities,
    credential: ResolvedCliCredential,
    option: CliOption,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          connection.kind,
          connection.surfaces.native,
          connection.surfaces.gateway,
          model.ref,
          model.upstreamProvider,
          this.#modelReceiptKey(connection, model),
          option.effort,
          option.speed,
          credential.accountKey,
          credential.provider,
          credential.mode,
          credential.credentialProvider,
        ]),
      )
      .digest('hex');
  }

  /** Combined admission pre-check: known account-window exhaustion plus the persistent guard. */
  #assertAdmissible(
    connection: CliConnection,
    model: CliModelCapabilities,
    credential: ResolvedCliCredential,
  ): void {
    this.#assertAccountCapacity(connection, model);
    const identity = this.#capacityIdentity(connection, model, credential);
    this.#syncCapacityAccount(connection.kind, identity);
    this.#assertCapacityAllowed(identity, connection);
  }

  /** Identity account + actual selected upstream + native bucket used for capacity scoping. */
  #capacityIdentity(
    connection: CliConnection,
    model: CliModelCapabilities,
    credential: ResolvedCliCredential,
  ): CliCapacityIdentity {
    const upstreamProvider =
      connection.kind === 'opencode-cli'
        ? (credential.provider ?? model.upstreamProvider ?? null)
        : null;
    return {
      connectionId: connection.kind,
      accountKey: credential.accountKey,
      upstreamProvider,
      bucketId: null,
    };
  }

  /**
   * Clear capacity blocks for the *correct old scope* when the resolved account changes. Scoped by
   * connection + upstream provider so a Zen account change never clears a Go block.
   */
  #syncCapacityAccount(kind: CliConnectionKind, identity: CliCapacityIdentity): void {
    const scope = `${kind}\u0000${identity.upstreamProvider ?? ''}`;
    const previous = this.#accountScopes.get(scope);
    if (previous === undefined) {
      this.#accountScopes.set(scope, identity.accountKey);
      return;
    }
    if (previous === identity.accountKey) return;
    this.#accountScopes.set(scope, identity.accountKey);
    this.#capacity.accountChanged(kind, previous, identity.accountKey);
  }

  /** Throw a typed, redacted error when the current identity is inside an active capacity block. */
  #assertCapacityAllowed(identity: CliCapacityIdentity, connection: CliConnection): void {
    const decision = this.#capacity.check(identity);
    if (decision.allowed || !decision.block) return;
    const block = decision.block;
    throw new CliTransportError(block.kind, block.reason, {
      accountKey: block.identity.accountKey ?? connection.account.key,
      bucketId: block.identity.bucketId ?? null,
      resetAt: block.resetAt,
      retryAfterMs: block.retryAfterMs,
    });
  }

  #recordCapacity(identity: CliCapacityIdentity, error: CliTransportError): void {
    this.#capacity.record(identity, error);
  }

  /** Read-only snapshot of active capacity blocks (diagnostics/tests). Never exposes secrets. */
  capacityBlocks(): readonly CliCapacityBlock[] {
    return this.#capacity.snapshot();
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
          model.defaultEffort,
          model.speeds,
          model.contextWindow,
          model.maxOutput,
          model.billing,
          model.toolCalling,
          model.modalities,
          // Effective unavailable-control reasons, so a change in what the bridge can actually run
          // invalidates the receipt even when the raw advertised token list is unchanged.
          unsupportedEffortsFor(model),
          // Actual selected upstream provider, so a Zen model's receipt is bound independently of a
          // Go model's on the same OpenCode connection (one connection, several credential buckets).
          model.upstreamProvider,
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
    const receipts = connection.verify.modelReceipts;
    if (receipts) {
      const kept: Record<ModelRef, CliModelReceipt> = {};
      for (const [ref, receipt] of Object.entries(receipts)) {
        const model = connection.models.find((candidate) => candidate.ref === ref);
        if (
          model &&
          receipt.receiptKey != null &&
          receipt.receiptKey === this.#modelReceiptKey(connection, model)
        )
          kept[ref as ModelRef] = receipt;
      }
      // Unchanged: return without persisting or emitting, so reads of a stable cache stay side-effect
      // free (no duplicate updates/events, no subscriber churn).
      if (Object.keys(kept).length === Object.keys(receipts).length) return connection;
      const verify: CliConnection['verify'] =
        Object.keys(kept).length > 0
          ? { ...connection.verify, modelReceipts: kept }
          : {
              state: 'stale',
              modelRef: connection.verify.modelRef,
              checkedAt: connection.verify.checkedAt,
              message:
                'The CLI account, version, capabilities or credential changed since this was verified.',
              receiptKey: null,
            };
      // Persist and publish the surviving receipts so no caller (RPC list, UI, CLI) can read the
      // dropped proof: the filtered map must leave the in-memory/persisted cache, not just a clone.
      this.#connectionService.applyVerification(connection.kind, verify);
      return { ...connection, verify };
    }
    if (
      connection.verify.receiptKey != null &&
      connection.verify.receiptKey === this.#legacyReceiptKey(connection)
    )
      return connection;
    const verify: CliConnection['verify'] = {
      state: 'stale',
      modelRef: connection.verify.modelRef,
      checkedAt: connection.verify.checkedAt,
      message:
        connection.verify.receiptKey == null
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
    // Bind a placeholder emit only when no target exists; a real host registration performed later
    // (e.g. by the `cliConnections` domain) still wins, so NoOp-first construction never drops RPC
    // updates and a later NoOp call never overwrites the real target.
    bindCliEmit(services, emit);
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
