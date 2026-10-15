import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mapProviderError } from '@ferry/providers';
import { classifyProviderError } from '@ferry/router';
import { CliEffortSchema, type CliEffort } from '@ferry/shared';
import { GatewayQueue } from './queue.js';
export { GatewayQueue, GatewayQueueError } from './queue.js';
import {
  canonicalToGatewayMessages,
  anthropicToCanonical,
  anthropicReasoningEffort,
  finalizeCanonicalStream,
  geminiToCanonical,
  openAiChatToCanonical,
  openAiResponsesToCanonical,
} from './canonical.js';

export type GatewayProfile = string;
export interface GatewayKey {
  id: string;
  name: string;
  client?: string;
  profile: GatewayProfile;
  allowedModels: string[];
  rateLimit: number | null;
  tokenLimitPerMinute: number | null;
  tokenLimitPerDay: number | null;
  concurrencyLimit: number | null;
  paidBackup?: boolean;
  budgetUsd?: number | null;
  /** Ephemeral Core-issued synthetic-test ceiling; never persisted on keys. */
  requestCostCapUsd?: number;
  compressToolResults: boolean;
  terseSystemPrompt: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  hash: string;
}
export interface GatewayStore {
  list(): GatewayKey[];
  put(key: GatewayKey): void;
  delete(id: string): void;
  recordRequest(keyId: string, at: string): void;
  recentRequests(keyId: string, now: string): number;
  recordUsage(
    keyId: string,
    inputTokens: number,
    outputTokens: number,
    at: string,
    cachedTokens?: number,
    reported?: boolean,
  ): void;
  tokenUsage(keyId: string, now: string): { minuteTokens: number; dayTokens: number };
  usage(keyId: string): {
    requests: number;
    successfulRequests: number;
    inputTokens: number;
    outputTokens: number;
  };
  touch(keyId: string, at: string): void;
}
export interface GatewayMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type?: string; function: { name: string; arguments: string } }[];
}
export interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  /** Raw reasoning-effort token; native CLI tokens are preserved, not narrowed to the API enum. */
  reasoning_effort?: string;
  reasoning?: { effort?: string };
  /** Requested service tier: standard/default/auto map to standard, fast/priority to fast. */
  service_tier?: string;
}
export interface GatewayCompletion {
  id: string;
  model: string;
  traceId?: string;
  attempts?: GatewayAttempt[];
  responseModel?: string | null;
  text: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** Nullable usage dimensions: `null`/absent means the producer did not report that dimension. */
  inputTokens?: number | null;
  cachedTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  /**
   * Explicit reporting signal. When false, no usage dimension is truthful and callers must not
   * surface a fabricated `0`. Defaults to true when any numeric token dimension is present.
   */
  usageReported?: boolean;
  finishReason: string;
  reasoning?: string;
  /** Actual upstream producer/account captured before any queue wait; never the current account. */
  servedProviderId?: string | null;
  servedConnectionId?: string | null;
  servedAccountKey?: string | null;
}
export interface GatewayAttempt {
  model: string;
  status: 'started' | 'failed' | 'served' | 'skipped';
  reason?: string;
  durationMs?: number;
  costUsd?: number;
  estimatedCost?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Actual producer/connection/account evidence captured before the attempt resolved. */
  providerId?: string | null;
  connectionId?: string | null;
  accountKey?: string | null;
  bucketId?: string | null;
  resetAt?: string | null;
  retryAfterMs?: number | null;
}
export interface GatewayAttemptState {
  servedModel: string;
  attempts: GatewayAttempt[];
}
interface FerryRequestState extends GatewayAttemptState {
  requestedModel: string;
  traceId: string;
}

export {
  anthropicToCanonical,
  canonicalStreamEventsToAnthropic,
  canonicalStreamEventsToGemini,
  canonicalStreamEventsToOpenAiChat,
  canonicalStreamEventsToResponses,
  canonicalToAnthropicMessage,
  canonicalToGemini,
  canonicalToGatewayMessages,
  canonicalToOpenAiChat,
  canonicalToResponses,
  finalizeCanonicalStream,
  geminiToCanonical,
  openAiChatToCanonical,
  openAiResponsesToCanonical,
} from './canonical.js';
export type {
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalUsage,
  CanonicalToolCall,
} from './canonical.js';
export interface GatewayRuntime {
  store: GatewayStore;
  inputTokenBound?(key: GatewayKey, model: string): Promise<number>;
  unavailable?(key: GatewayKey): { code: string; statusCode: number; message: string };
  rejected?(input: {
    key: GatewayKey;
    at: string;
    traceId: string;
    code: string;
    durationMs: number;
  }): void;
  models(key: GatewayKey, profile?: string): string[] | Promise<string[]>;
  complete(input: {
    key: GatewayKey;
    model: string;
    requestedModel?: string;
    receivedAt?: string;
    queueWaitMs?: number;
    messages: GatewayMessage[];
    instructions?: string;
    tools?: unknown[];
    toolChoice?: unknown;
    parallelToolCalls?: boolean;
    jsonMode?: boolean;
    structuredOutput?: { name: string; schema: Record<string, unknown>; strict?: boolean };
    maxTokens?: number;
    temperature?: number;
    /** Raw reasoning-effort token; support is validated against the resolved model before dispatch. */
    effort?: CliEffort;
    /** Requested speed tier after `service_tier` mapping; absent means the standard default. */
    serviceTier?: 'standard' | 'fast';
    sessionHint: string;
    signal: AbortSignal;
    traceId?: string;
    onAttempt?: (state: GatewayAttemptState) => void;
    onText?: (delta: string) => void | Promise<void>;
    onToolCall?: (tool: { id: string; name: string; arguments: string }) => void | Promise<void>;
  }): Promise<GatewayCompletion>;
}

export function structuredOutputOptions(value: unknown): {
  jsonMode?: boolean;
  structuredOutput?: { name: string; schema: Record<string, unknown>; strict?: boolean };
} {
  if (value == null) return {};
  if (typeof value !== 'object') throw new GatewayRequestError('Invalid structured output format.');
  const format = value as Record<string, unknown>;
  if (format.type === 'text') return {};
  if (format.type === 'json_object') return { jsonMode: true };
  const nested =
    format.json_schema && typeof format.json_schema === 'object'
      ? (format.json_schema as Record<string, unknown>)
      : format;
  if (
    format.type !== 'json_schema' ||
    !nested.schema ||
    typeof nested.schema !== 'object' ||
    Array.isArray(nested.schema)
  )
    throw new GatewayRequestError(
      'Unsupported structured output format. Provide json_object or json_schema with an object schema.',
    );
  return {
    structuredOutput: {
      name: typeof nested.name === 'string' ? nested.name : 'response',
      schema: nested.schema as Record<string, unknown>,
      ...(typeof nested.strict === 'boolean' ? { strict: nested.strict } : {}),
    },
  };
}
export interface GatewayOptions {
  port?: number;
  allowLan?: boolean;
  allowLanConfirmed?: boolean;
  runtime: GatewayRuntime;
  /** Ephemeral core-issued tokens; callers must keep this map in memory only. */
  internalTokens?: Map<string, { keyId: string; expiresAt: number; testCostCapUsd?: number }>;
  queueCapacity?: number;
  concurrency?: number;
  requestDeadlineMs?: number;
}
export interface GatewayHandle {
  readonly port: number;
  readonly host: string;
  activity(): { active: number; queued: number };
  close(): Promise<void>;
}

const requestControllers = new WeakMap<IncomingMessage, AbortController>();
function requestController(req: IncomingMessage): AbortController {
  return requestControllers.get(req) ?? new AbortController();
}
async function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!res.writableNeedDrain) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', drained);
      res.off('close', closed);
      signal.removeEventListener('abort', aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error('Client disconnected during stream.'));
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled.'));
    };
    res.once('drain', drained);
    res.once('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: (error: Error) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled.'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

const aliases: Record<string, GatewayProfile> = {
  'ferry/auto': 'auto-free',
  'ferry/auto-free': 'auto-free',
  'ferry/best': 'best',
  'ferry/fast': 'fast',
  'ferry/long-context': 'long-context',
};
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const secondsToUtcDayReset = (now: Date) =>
  Math.ceil(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) /
      1000,
  );

export function pruneRateState<K>(state: Map<K, number[]>, now: number): void {
  for (const [key, times] of state) {
    const recent = times.filter((at) => now - at < 60_000);
    if (recent.length) state.set(key, recent);
    else state.delete(key);
  }
}

export class GatewayRequestError extends Error {
  readonly code = 'invalid_request_error';
  constructor(message: string) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}
function outputTokenLimit(value: unknown): number {
  if (value === undefined) return 4096;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000)
    throw new GatewayRequestError(
      'Output token limit must be a positive integer, no greater than 1000000.',
    );
  return value;
}

/** Reported vs unreported token usage. `null` is a genuinely unreported dimension, never a fake 0. */
export interface GatewayUsageReport {
  reported: boolean;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * Normalize one completion's usage. A producer that did not report usage yields `reported: false`
 * with every dimension `null`, so the transport omits usage instead of fabricating `0`. A real
 * reported `0` stays `0`.
 */
export function completionUsage(result: GatewayCompletion): GatewayUsageReport {
  const dimension = (value: number | null | undefined): number | null =>
    typeof value === 'number' ? value : null;
  const reported =
    result.usageReported ??
    (dimension(result.inputTokens) !== null ||
      dimension(result.outputTokens) !== null ||
      dimension(result.cachedTokens) !== null ||
      dimension(result.reasoningTokens) !== null);
  return {
    reported,
    inputTokens: dimension(result.inputTokens),
    cachedTokens: dimension(result.cachedTokens),
    outputTokens: dimension(result.outputTokens),
    reasoningTokens: dimension(result.reasoningTokens),
  };
}

/**
 * Preserve the caller's raw reasoning-effort token. Native CLI tokens (`ultra`, `none`, future
 * names) are accepted verbatim; whether the resolved model supports the token is checked at dispatch.
 * A malformed explicit value is a 400 rather than being silently ignored or sanitized.
 */
export function parseReasoningEffort(value: unknown): { effort?: CliEffort } {
  if (value === undefined || value === null) return {};
  const parsed = CliEffortSchema.safeParse(typeof value === 'string' ? value.trim() : value);
  if (!parsed.success)
    throw new GatewayRequestError(
      'Unsupported reasoning_effort. Provide a lowercase effort token such as low, medium, high, xhigh, max, none or a token advertised by the target model.',
    );
  return { effort: parsed.data };
}

/**
 * Map the OpenAI `service_tier` control onto a Ferry speed. Only the tiers this bridge can actually
 * run are accepted: `auto`/`default`/`standard` select the standard default, `fast`/`priority`
 * select the separately-billed fast/priority tier. Any other explicit value is a 400 before dispatch.
 */
export function parseServiceTier(value: unknown): { serviceTier?: 'standard' | 'fast' } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') throw new GatewayRequestError('service_tier must be a string.');
  const token = value.trim().toLowerCase();
  if (token === 'auto' || token === 'default' || token === 'standard')
    return { serviceTier: 'standard' };
  if (token === 'fast' || token === 'priority') return { serviceTier: 'fast' };
  throw new GatewayRequestError(
    `Unsupported service_tier "${value}". Supported values: auto, default, standard, fast, priority.`,
  );
}

/**
 * OpenAI Chat usage fields. Omitted entirely when usage was unreported, so an unknown turn never
 * surfaces a fabricated `0`. When reported, individual nullable dimensions stay `null`.
 */
export function openAiUsage(usage: GatewayUsageReport): { usage?: Record<string, unknown> } {
  if (!usage.reported) return {};
  return {
    usage: {
      prompt_tokens: usage.inputTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedTokens },
      completion_tokens: usage.outputTokens,
      // Forward reported reasoning tokens; omit the detail entirely when the producer did not report
      // any, so an unreported dimension is never shown as a genuine `0`.
      ...(usage.reasoningTokens === null
        ? {}
        : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
      total_tokens:
        usage.inputTokens !== null && usage.outputTokens !== null
          ? usage.inputTokens + usage.outputTokens
          : null,
    },
  };
}

/** Responses usage fields; omitted when unreported. */
export function responsesUsage(usage: GatewayUsageReport): { usage?: Record<string, unknown> } {
  if (!usage.reported) return {};
  return {
    usage: {
      input_tokens: usage.inputTokens,
      input_tokens_details: { cached_tokens: usage.cachedTokens },
      output_tokens: usage.outputTokens,
      ...(usage.reasoningTokens === null
        ? {}
        : { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
      total_tokens:
        usage.inputTokens !== null && usage.outputTokens !== null
          ? usage.inputTokens + usage.outputTokens
          : null,
    },
  };
}

/** Anthropic usage fields; omitted when unreported. */
export function anthropicUsage(usage: GatewayUsageReport): { usage?: Record<string, unknown> } {
  if (!usage.reported) return {};
  return {
    usage: {
      input_tokens: usage.inputTokens,
      cache_read_input_tokens: usage.cachedTokens,
      output_tokens: usage.outputTokens,
    },
  };
}

/** Gemini usage metadata; omitted when unreported. */
export function geminiUsage(usage: GatewayUsageReport): {
  usageMetadata?: Record<string, unknown>;
} {
  if (!usage.reported) return {};
  return {
    usageMetadata: {
      promptTokenCount: usage.inputTokens,
      cachedContentTokenCount: usage.cachedTokens,
      candidatesTokenCount: usage.outputTokens,
      totalTokenCount:
        usage.inputTokens !== null && usage.outputTokens !== null
          ? usage.inputTokens + usage.outputTokens
          : null,
    },
  };
}

export function createGatewayKey(
  input: Pick<GatewayKey, 'name' | 'profile'> & Partial<GatewayKey>,
  now = new Date(),
): { key: GatewayKey; secret: string } {
  const secret = `ferry-gw-${randomBytes(32).toString('base64url')}`;
  const key: GatewayKey = {
    id: randomBytes(12).toString('hex'),
    name: input.name.trim(),
    ...(input.client ? { client: input.client } : {}),
    profile: input.profile,
    allowedModels: input.allowedModels ?? [],
    rateLimit: input.rateLimit ?? null,
    tokenLimitPerMinute: input.tokenLimitPerMinute ?? null,
    tokenLimitPerDay: input.tokenLimitPerDay ?? null,
    concurrencyLimit: input.concurrencyLimit ?? null,
    paidBackup: input.paidBackup ?? false,
    budgetUsd: input.budgetUsd ?? null,
    compressToolResults: input.compressToolResults ?? false,
    terseSystemPrompt: input.terseSystemPrompt ?? false,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    hash: hashToken(secret),
  };
  return { key, secret };
}

export function authenticateGatewayKey(token: string, keys: GatewayKey[]): GatewayKey | undefined {
  const candidate = Buffer.from(hashToken(token), 'hex');
  for (const key of keys) {
    const expected = Buffer.from(key.hash, 'hex');
    if (
      expected.length === candidate.length &&
      timingSafeEqual(candidate, expected) &&
      !key.revokedAt
    )
      return key;
  }
  return undefined;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  ferry?: ReturnType<typeof ferryMetadata>,
): void {
  if (ferry) setFerryHeaders(res, ferry);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
function createFerryRequestState(requestedModel: string): FerryRequestState {
  return {
    requestedModel,
    traceId: `ferry_${randomBytes(12).toString('hex')}`,
    servedModel: '',
    attempts: [],
  };
}
function ferryMetadata(
  state: FerryRequestState,
  completion?: GatewayCompletion,
): {
  traceId: string;
  requestedModel: string;
  servedModel: string | null;
  servedProviderId: string | null;
  servedConnectionId: string | null;
  servedAccountKey: string | null;
  attempts: GatewayAttempt[];
  responseModel: string | null;
  mismatch: boolean;
  usageReported: boolean | null;
} {
  const servedModel = completion?.model ?? completion?.attempts?.at(-1)?.model ?? state.servedModel;
  const attempts = completion?.attempts ?? state.attempts;
  const responseModel = completion?.responseModel ?? null;
  const servedModelId = servedModel.split('/').slice(1).join('/');
  return {
    traceId: completion?.traceId ?? state.traceId,
    requestedModel: state.requestedModel,
    servedModel: servedModel || null,
    servedProviderId:
      completion?.servedProviderId ?? (servedModel ? (servedModel.split('/', 1)[0] ?? null) : null),
    servedConnectionId: completion?.servedConnectionId ?? null,
    servedAccountKey: completion?.servedAccountKey ?? null,
    attempts: attempts.length
      ? attempts
      : servedModel
        ? [{ model: servedModel, status: 'served' }]
        : [],
    responseModel,
    mismatch: Boolean(
      responseModel &&
      servedModel &&
      responseModel !== servedModel &&
      responseModel !== servedModelId,
    ),
    usageReported: completion ? completionUsage(completion).reported : null,
  };
}
function observeAttempt(state: FerryRequestState, attempt: GatewayAttemptState): void {
  state.servedModel = attempt.servedModel;
  state.attempts = attempt.attempts;
}
function observeCompletion(state: FerryRequestState, completion: GatewayCompletion): void {
  if (completion.model) state.servedModel = completion.model;
  if (completion.attempts) state.attempts = completion.attempts;
}
function ferryAttemptOptions(state: FerryRequestState): {
  traceId: string;
  requestedModel: string;
  onAttempt: (attempt: GatewayAttemptState) => void;
} {
  return {
    traceId: state.traceId,
    requestedModel: state.requestedModel,
    onAttempt: (attempt) => {
      observeAttempt(state, attempt);
    },
  };
}
function setFerryHeaders(res: ServerResponse, metadata: ReturnType<typeof ferryMetadata>): void {
  res.setHeader('x-ferry-requested-model', metadata.requestedModel);
  if (metadata.servedModel) res.setHeader('x-ferry-served-model', metadata.servedModel);
  if (metadata.responseModel) res.setHeader('x-ferry-response-model', metadata.responseModel);
  if (metadata.servedProviderId)
    res.setHeader('x-ferry-served-provider', metadata.servedProviderId);
  if (metadata.servedConnectionId)
    res.setHeader('x-ferry-served-connection', metadata.servedConnectionId);
  if (metadata.servedAccountKey) res.setHeader('x-ferry-served-account', metadata.servedAccountKey);
  if (metadata.usageReported !== null)
    res.setHeader('x-ferry-usage-reported', String(metadata.usageReported));
  res.setHeader('x-ferry-attempts', String(metadata.attempts.length));
  res.setHeader('x-ferry-trace-id', metadata.traceId);
}
/**
 * Ferry routing metadata as a named SSE event. Sent only on Anthropic Messages streams, whose SDKs
 * skip unknown event types; OpenAI-format and Gemini clients get the same data from `x-ferry-*`.
 */
function sendFerryMetadata(
  send: (event: string, data: unknown) => void,
  state: FerryRequestState,
  completion?: GatewayCompletion,
): void {
  const metadata = ferryMetadata(state, completion);
  send('ferry.metadata', {
    trace_id: metadata.traceId,
    requested_model: metadata.requestedModel,
    served_model: metadata.servedModel,
    served_provider: metadata.servedProviderId,
    served_connection: metadata.servedConnectionId,
    served_account: metadata.servedAccountKey,
    attempts: metadata.attempts,
    response_model: metadata.responseModel,
    mismatch: metadata.mismatch,
    usage_reported: metadata.usageReported,
  });
}
function errorBody(message: string, type = 'invalid_request_error', code: string | null = null) {
  return { error: { message, type, param: null, code } };
}
function anthropicError(message: string, type = 'invalid_request_error') {
  return { type: 'error', error: { type, message } };
}
function mappedFailure(error: unknown) {
  const errorName =
    error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  if (
    error instanceof GatewayRequestError ||
    /AI_InvalidPromptError|AI_TypeValidationError|AI_NoSuchToolError|ZodError|SchemaValidationError|ValidationError/.test(
      errorName,
    )
  ) {
    return {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request_error',
      message: error instanceof Error ? error.message : 'Invalid request',
    };
  }
  const outer = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  if (
    typeof outer.code === 'string' &&
    [
      'budget_exhausted',
      'upstream_credentials',
      'quota_exhausted',
      'unsupported_request',
      'request_timeout',
      'queue_full',
    ].includes(outer.code)
  )
    return {
      status: Number(outer.statusCode ?? 502),
      type: outer.code,
      code: outer.code,
      message: error instanceof Error ? error.message : outer.code,
      retryable: false,
    };
  const record =
    outer.name === 'AI_StreamProviderError' && outer.cause && typeof outer.cause === 'object'
      ? (outer.cause as Record<string, unknown>)
      : outer;
  const mapped = mapProviderError(error);
  const classified = classifyProviderError({
    status: record.status,
    statusCode: record.statusCode,
    code: record.code,
    type: record.type,
    message: record.message,
    responseBody: record.data ?? record.responseBody,
    ...(record.response instanceof Response ? { headers: record.response.headers } : {}),
  });
  const rawStatus = Number(classified.status ?? record.statusCode ?? record.status ?? 0);
  const status =
    rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : mapped.kind === 'auth'
        ? 401
        : mapped.kind === 'rate_limit' || mapped.kind === 'quota_exhausted'
          ? 429
          : mapped.kind === 'model_not_found'
            ? 404
            : mapped.kind === 'request_scoped_client' || mapped.kind === 'context_overflow'
              ? 400
              : 502;
  const type =
    status === 401
      ? 'authentication_error'
      : status === 429
        ? 'rate_limit_error'
        : status === 400
          ? 'invalid_request_error'
          : status >= 500
            ? 'server_error'
            : 'invalid_request_error';
  return {
    status,
    type,
    code: status === 401 || status === 403 ? 'upstream_credentials' : classified.family,
    message: mapped.message,
    retryable: classified.retryable,
  };
}
function normalizeMessages(raw: unknown[]): { messages: GatewayMessage[]; instructions: string } {
  const canonical = openAiChatToCanonical({ model: '', messages: raw });
  if (canonical.messages.length !== raw.length)
    throw new GatewayRequestError('Invalid message role or shape');
  return canonicalToGatewayMessages(canonical.messages);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 8 * 1024 * 1024) throw new Error('Request body exceeds 8 MiB');
    chunks.push(new Uint8Array(data));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  const key = req.headers['x-api-key'];
  return match?.[1] ?? (typeof key === 'string' ? key : undefined);
}
function anthropicTools(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    return typeof item.name === 'string'
      ? [
          {
            type: 'function',
            function: {
              name: item.name,
              description: item.description,
              parameters: item.input_schema,
            },
          },
        ]
      : [];
  });
}
function modelFor(raw: string, key: GatewayKey): string {
  const alias =
    raw === 'ferry/auto'
      ? key.profile
      : (aliases[raw] ??
        (raw.startsWith('ferry/profile_') ? raw.slice('ferry/'.length) : undefined));
  const model = raw.startsWith('ferry/') ? (alias ? `@profile:${alias}` : '') : raw;
  if (
    !model ||
    (key.allowedModels.length > 0 &&
      !key.allowedModels.includes(raw) &&
      !(alias && key.allowedModels.every((ref) => ref.includes('/') && !ref.startsWith('ferry/'))))
  )
    throw new Error('Unknown model');
  return alias ? `@profile:${alias}` : model;
}
function reasoningInput(input: GatewayRequest): { effort?: CliEffort } {
  return parseReasoningEffort(input.reasoning_effort ?? input.reasoning?.effort);
}
async function tokenEstimate(
  runtime: GatewayRuntime,
  key: GatewayKey,
  model: string,
  payload: unknown,
  messages: GatewayMessage[],
  output: number,
): Promise<number> {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  const image = messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => !!part && typeof part === 'object' && 'image' in part),
  );
  return image && runtime.inputTokenBound
    ? Math.max(bytes + output, await runtime.inputTokenBound(key, model))
    : bytes + output;
}
function chatChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayRuntime,
  key: GatewayKey,
  reserve: (key: GatewayKey, tokens: number) => { retryAfter: number | null; release(): void },
): Promise<void> {
  let input: GatewayRequest;
  try {
    input = (await body(req)) as unknown as GatewayRequest;
    input.max_tokens = outputTokenLimit(input.max_tokens ?? input.max_completion_tokens);
  } catch (error) {
    json(res, 400, errorBody(error instanceof Error ? error.message : 'Invalid JSON'));
    return;
  }
  if (typeof input.model !== 'string' || !Array.isArray(input.messages)) {
    json(res, 400, errorBody('model and messages are required'));
    return;
  }
  let model: string;
  try {
    model = modelFor(input.model, key);
  } catch {
    json(res, 404, errorBody(`Unknown model: ${input.model}`, 'model_not_found'));
    return;
  }
  const requestedProfile = input.model === 'ferry/auto' ? key.profile : aliases[input.model];
  if (
    (requestedProfile && (await runtime.models(key, requestedProfile)).length === 0) ||
    (!requestedProfile &&
      !model.startsWith('@profile:') &&
      !(await runtime.models(key)).includes(model))
  ) {
    if (requestedProfile) {
      const failure = runtime.unavailable?.(key) ?? {
        statusCode: 400,
        code: 'unsupported_request',
        message: 'No upstream route is available. Connect a provider or review this key’s policy.',
      };
      json(res, failure.statusCode, errorBody(failure.message, failure.code, failure.code));
    } else json(res, 404, errorBody(`Unknown model: ${input.model}`, 'model_not_found'));
    return;
  }
  const ferryState = createFerryRequestState(input.model);
  let normalized: ReturnType<typeof normalizeMessages>;
  try {
    normalized = normalizeMessages(input.messages);
  } catch (error) {
    const mapped = mappedFailure(error);
    json(res, mapped.status, errorBody(mapped.message, mapped.type, mapped.code));
    return;
  }
  const reserved = reserve(
    key,
    await tokenEstimate(runtime, key, model, input, normalized.messages, input.max_tokens ?? 4096),
  );
  if (reserved.retryAfter !== null) {
    res.setHeader('retry-after', String(reserved.retryAfter));
    json(res, 429, errorBody('Ferry gateway key token budget exceeded', 'rate_limit_error'));
    return;
  }
  const controller = requestController(req);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
  const sessionHint = String(
    req.headers['x-ferry-session'] ??
      req.headers['x-session-id'] ??
      createHash('sha256')
        .update(JSON.stringify(input.messages[0] ?? {}))
        .digest('hex'),
  );
  const recordUsage = (reported: GatewayUsageReport) => {
    runtime.store.recordUsage(
      key.id,
      reported.inputTokens ?? 0,
      reported.outputTokens ?? 0,
      new Date().toISOString(),
      reported.cachedTokens ?? 0,
      reported.reported,
    );
  };
  try {
    if (input.stream) {
      let streamStarted = false;
      const beginStream = (completion?: GatewayCompletion) => {
        if (streamStarted) return;
        streamStarted = true;
        setFerryHeaders(res, ferryMetadata(ferryState, completion));
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(chatChunk(id, input.model, { role: 'assistant' }))}\n\n`);
      };
      let tools: GatewayCompletion['toolCalls'] = [];
      const result = await runtime.complete({
        key,
        model,
        messages: normalized.messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.tool_choice !== undefined ? { toolChoice: input.tool_choice } : {}),
        ...(input.parallel_tool_calls !== undefined
          ? { parallelToolCalls: input.parallel_tool_calls }
          : {}),
        ...structuredOutputOptions(input.response_format),
        ...(input.max_tokens ? { maxTokens: input.max_tokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...reasoningInput(input),
        ...parseServiceTier(input.service_tier),
        sessionHint,
        signal: controller.signal,
        ...ferryAttemptOptions(ferryState),
        onText: (delta) => {
          beginStream();
          res.write(`data: ${JSON.stringify(chatChunk(id, input.model, { content: delta }))}\n\n`);
        },
        onToolCall: (tool) => {
          beginStream();
          tools = [...(tools ?? []), tool];
        },
      });
      reserved.release();
      observeCompletion(ferryState, result);
      beginStream(result);
      const usage = completionUsage(result);
      if (tools.length)
        res.write(
          `data: ${JSON.stringify(chatChunk(id, input.model, { tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) }))}\n\n`,
        );
      const finishReason = tools.length ? 'tool_calls' : result.finishReason;
      res.write(
        `data: ${JSON.stringify({ ...chatChunk(id, input.model, {}, finishReason), choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...openAiUsage(usage) })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      recordUsage(usage);
    } else {
      const result = await runtime.complete({
        key,
        model,
        messages: normalized.messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.tool_choice !== undefined ? { toolChoice: input.tool_choice } : {}),
        ...(input.parallel_tool_calls !== undefined
          ? { parallelToolCalls: input.parallel_tool_calls }
          : {}),
        ...structuredOutputOptions(input.response_format),
        ...(input.max_tokens ? { maxTokens: input.max_tokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...reasoningInput(input),
        ...parseServiceTier(input.service_tier),
        sessionHint,
        signal: controller.signal,
        ...ferryAttemptOptions(ferryState),
      });
      reserved.release();
      observeCompletion(ferryState, result);
      const usage = completionUsage(result);
      json(
        res,
        200,
        {
          id: result.id || id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: input.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: result.text || null,
                ...(result.toolCalls?.length
                  ? {
                      tool_calls: result.toolCalls.map((tool) => ({
                        id: tool.id,
                        type: 'function',
                        function: { name: tool.name, arguments: tool.arguments },
                      })),
                    }
                  : {}),
              },
              finish_reason: result.toolCalls?.length ? 'tool_calls' : result.finishReason,
            },
          ],
          ...openAiUsage(usage),
        },
        ferryMetadata(ferryState, result),
      );
      recordUsage(usage);
    }
  } catch (error) {
    reserved.release();
    const mapped = mappedFailure(error);
    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: { message: mapped.message, type: mapped.type, code: mapped.code } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    } else json(res, mapped.status, errorBody(mapped.message, mapped.type, mapped.code));
  }
}

async function handleAnthropic(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayRuntime,
  key: GatewayKey,
  reserve: (key: GatewayKey, tokens: number) => { retryAfter: number | null; release(): void },
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await body(req);
    payload.max_tokens = outputTokenLimit(payload.max_tokens);
  } catch (error) {
    json(res, 400, errorBody(error instanceof Error ? error.message : 'Invalid JSON'));
    return;
  }
  if (typeof payload.model !== 'string' || !Array.isArray(payload.messages)) {
    json(res, 400, anthropicError('model and messages are required'));
    return;
  }
  const originalModel = payload.model;
  let model: string;
  try {
    model = modelFor(originalModel, key);
  } catch {
    json(res, 404, anthropicError(`Unknown model: ${originalModel}`, 'not_found_error'));
    return;
  }
  const requestedProfile = originalModel === 'ferry/auto' ? key.profile : aliases[originalModel];
  if (
    (requestedProfile && (await runtime.models(key, requestedProfile)).length === 0) ||
    (!requestedProfile &&
      !model.startsWith('@profile:') &&
      !(await runtime.models(key)).includes(model))
  ) {
    if (requestedProfile) {
      const failure = runtime.unavailable?.(key) ?? {
        statusCode: 400,
        code: 'unsupported_request',
        message: 'No upstream route is available. Connect a provider or review this key’s policy.',
      };
      json(res, failure.statusCode, {
        type: 'error',
        error: {
          type:
            failure.statusCode === 429
              ? 'rate_limit_error'
              : failure.statusCode === 401
                ? 'authentication_error'
                : 'invalid_request_error',
          code: failure.code,
          message: failure.message,
        },
      });
    } else json(res, 404, anthropicError(`Unknown model: ${originalModel}`, 'not_found_error'));
    return;
  }
  const ferryState = createFerryRequestState(originalModel);
  let normalized: ReturnType<typeof canonicalToGatewayMessages>;
  try {
    normalized = canonicalToGatewayMessages(
      anthropicToCanonical({
        model: originalModel,
        messages: payload.messages,
        system: payload.system,
      }).messages,
    );
  } catch (error) {
    const mapped = mappedFailure(error);
    json(res, mapped.status, anthropicError(mapped.message, mapped.type));
    return;
  }
  const reserved = reserve(
    key,
    await tokenEstimate(
      runtime,
      key,
      model,
      payload,
      normalized.messages,
      Number(payload.max_tokens),
    ),
  );
  if (reserved.retryAfter !== null) {
    res.setHeader('retry-after', String(reserved.retryAfter));
    json(res, 429, anthropicError('Ferry gateway key token budget exceeded', 'rate_limit_error'));
    return;
  }
  const tools = anthropicTools(payload.tools);
  const rawChoice =
    payload.tool_choice && typeof payload.tool_choice === 'object'
      ? (payload.tool_choice as Record<string, unknown>)
      : undefined;
  const toolChoice =
    rawChoice?.type === 'tool' && typeof rawChoice.name === 'string'
      ? { function: { name: rawChoice.name } }
      : rawChoice?.type === 'any'
        ? 'required'
        : rawChoice?.type === 'none'
          ? 'none'
          : rawChoice?.type === 'auto'
            ? 'auto'
            : undefined;
  const controller = requestController(req);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const id = `msg_${randomBytes(12).toString('hex')}`;
  const sessionHint = String(
    req.headers['x-ferry-session'] ??
      req.headers['x-session-id'] ??
      createHash('sha256')
        .update(JSON.stringify(payload.messages[0] ?? {}))
        .digest('hex'),
  );
  try {
    const messages = normalized.messages;
    const outputConfig =
      payload.output_config && typeof payload.output_config === 'object'
        ? (payload.output_config as Record<string, unknown>)
        : {};
    const controls = {
      ...structuredOutputOptions(outputConfig.format),
      ...(typeof rawChoice?.disable_parallel_tool_use === 'boolean'
        ? { parallelToolCalls: !rawChoice.disable_parallel_tool_use }
        : {}),
    };
    if (payload.stream === true) {
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let streamStarted = false;
      const textStarted = { value: false };
      const beginStream = (completion?: GatewayCompletion) => {
        if (streamStarted) return;
        streamStarted = true;
        setFerryHeaders(res, ferryMetadata(ferryState, completion));
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        send('message_start', {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model: originalModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
          },
        });
      };
      const toolCalls: GatewayCompletion['toolCalls'] = [];
      const result = await runtime.complete({
        key,
        model,
        messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...controls,
        ...(payload.max_tokens ? { maxTokens: Number(payload.max_tokens) } : {}),
        ...anthropicReasoningEffort(payload),
        ...parseServiceTier(payload.service_tier),
        ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
        sessionHint,
        signal: controller.signal,
        ...ferryAttemptOptions(ferryState),
        onText: (delta) => {
          beginStream();
          if (!textStarted.value) {
            textStarted.value = true;
            send('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
          }
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta },
          });
        },
        onToolCall: (call) => {
          beginStream();
          toolCalls.push(call);
        },
      });
      reserved.release();
      observeCompletion(ferryState, result);
      beginStream(result);
      const usage = completionUsage(result);
      if (textStarted.value) send('content_block_stop', { type: 'content_block_stop', index: 0 });
      if (result.reasoning) {
        const index = textStarted.value ? 1 : 0;
        send('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: result.reasoning },
        });
        send('content_block_stop', { type: 'content_block_stop', index });
      }
      for (let i = 0; i < (result.toolCalls?.length ?? 0); i++) {
        const call = result.toolCalls?.[i];
        if (!call) continue;
        send('content_block_start', {
          type: 'content_block_start',
          index: (textStarted.value ? 1 : 0) + (result.reasoning ? 1 : 0) + i,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: (textStarted.value ? 1 : 0) + (result.reasoning ? 1 : 0) + i,
          delta: { type: 'input_json_delta', partial_json: call.arguments },
        });
        send('content_block_stop', {
          type: 'content_block_stop',
          index: (textStarted.value ? 1 : 0) + (result.reasoning ? 1 : 0) + i,
        });
      }
      send('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        ...anthropicUsage(usage),
      });
      sendFerryMetadata(send, ferryState, result);
      send('message_stop', { type: 'message_stop' });
      res.end();
      runtime.store.recordUsage(
        key.id,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        new Date().toISOString(),
        usage.cachedTokens ?? 0,
        usage.reported,
      );
    } else {
      const result = await runtime.complete({
        key,
        model,
        messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...controls,
        ...(payload.max_tokens ? { maxTokens: Number(payload.max_tokens) } : {}),
        ...anthropicReasoningEffort(payload),
        ...parseServiceTier(payload.service_tier),
        ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
        sessionHint,
        signal: controller.signal,
        ...ferryAttemptOptions(ferryState),
      });
      reserved.release();
      observeCompletion(ferryState, result);
      const usage = completionUsage(result);
      runtime.store.recordUsage(
        key.id,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        new Date().toISOString(),
        usage.cachedTokens ?? 0,
        usage.reported,
      );
      json(
        res,
        200,
        {
          id,
          type: 'message',
          role: 'assistant',
          model: originalModel,
          content: [
            ...(result.reasoning ? [{ type: 'thinking', thinking: result.reasoning }] : []),
            ...(result.text ? [{ type: 'text', text: result.text }] : []),
            ...(result.toolCalls ?? []).map((call) => ({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: JSON.parse(call.arguments) as unknown,
            })),
          ],
          stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          ...anthropicUsage(usage),
        },
        ferryMetadata(ferryState, result),
      );
    }
  } catch (error) {
    reserved.release();
    const mapped = mappedFailure(error);
    if (res.headersSent) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: mapped.type, message: mapped.message } })}\n\n`,
      );
      sendFerryMetadata(
        (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        ferryState,
      );
      res.end();
    } else json(res, mapped.status, anthropicError(mapped.message, mapped.type));
  }
}

type Protocol = 'responses' | 'gemini';

function protocolError(
  res: ServerResponse,
  protocol: Protocol,
  status: number,
  message: string,
  code: string | null = null,
): void {
  json(
    res,
    status,
    protocol === 'responses'
      ? errorBody(
          message,
          status === 429
            ? 'rate_limit_error'
            : status === 401
              ? 'authentication_error'
              : status >= 500
                ? 'server_error'
                : 'invalid_request_error',
          code,
        )
      : {
          error: {
            code: status,
            status:
              status === 429
                ? 'RESOURCE_EXHAUSTED'
                : status === 401
                  ? 'UNAUTHENTICATED'
                  : status >= 500
                    ? 'INTERNAL'
                    : 'INVALID_ARGUMENT',
            message,
          },
        },
  );
}

async function handleCanonicalProtocol(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayRuntime,
  key: GatewayKey,
  protocol: Protocol,
  routeModel?: string,
  forceStream = false,
  reserve?: (key: GatewayKey, tokens: number) => { retryAfter: number | null; release(): void },
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await body(req);
  } catch (error) {
    protocolError(res, protocol, 400, error instanceof Error ? error.message : 'Invalid JSON');
    return;
  }

  let canonical;
  try {
    canonical =
      protocol === 'responses'
        ? openAiResponsesToCanonical(payload)
        : geminiToCanonical(payload, routeModel ?? '');
    canonical.maxTokens = outputTokenLimit(
      protocol === 'responses' ? payload.max_output_tokens : canonical.maxTokens,
    );
  } catch (error) {
    protocolError(res, protocol, 400, error instanceof Error ? error.message : 'Invalid request');
    return;
  }
  const originalModel =
    protocol === 'responses' ? canonical.model : (routeModel ?? canonical.model);
  let model: string;
  try {
    model = modelFor(originalModel, key);
  } catch {
    protocolError(res, protocol, 404, `Unknown model: ${originalModel}`);
    return;
  }
  const requestedProfile = originalModel === 'ferry/auto' ? key.profile : aliases[originalModel];
  if (
    (requestedProfile && (await runtime.models(key, requestedProfile)).length === 0) ||
    (!requestedProfile &&
      !model.startsWith('@profile:') &&
      !(await runtime.models(key)).includes(model))
  ) {
    if (requestedProfile) {
      const failure = runtime.unavailable?.(key) ?? {
        statusCode: 400,
        code: 'unsupported_request',
        message: 'No upstream route is available. Connect a provider or review this key’s policy.',
      };
      protocolError(res, protocol, failure.statusCode, failure.message, failure.code);
    } else protocolError(res, protocol, 404, `Unknown model: ${originalModel}`);
    return;
  }
  const ferryState = createFerryRequestState(originalModel);
  const converted = canonicalToGatewayMessages(canonical.messages);
  const estimate = await tokenEstimate(
    runtime,
    key,
    model,
    payload,
    converted.messages,
    canonical.maxTokens ?? 4096,
  );
  const reservation = reserve?.(key, estimate);
  if (reservation?.retryAfter !== null && reservation) {
    res.setHeader('retry-after', String(reservation.retryAfter));
    protocolError(res, protocol, 429, 'Ferry gateway key token budget exceeded');
    return;
  }
  const tools = canonical.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const responseId = protocol === 'responses' ? `resp_${randomBytes(12).toString('hex')}` : '';
  const stream = forceStream || canonical.stream;
  const controller = requestController(req);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const sessionHint = String(
    req.headers['x-ferry-session'] ??
      req.headers['x-session-id'] ??
      createHash('sha256')
        .update(JSON.stringify(payload.input ?? payload.contents ?? {}))
        .digest('hex'),
  );
  const deltas: { type: 'text_delta'; text: string }[] = [];
  const calls: NonNullable<GatewayCompletion['toolCalls']> = [];
  const streamedCallIds = new Set<string>();
  const responseSend = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let responseMessageStarted = false;
  let responseMessageIndex: number | undefined;
  let nextOutputIndex = 0;
  const callOutputIndexes = new Map<string, number>();
  let streamStarted = false;
  const beginStream = (completion?: GatewayCompletion) => {
    if (!stream || streamStarted) return;
    streamStarted = true;
    setFerryHeaders(res, ferryMetadata(ferryState, completion));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (protocol === 'responses') {
      const started = {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        model: originalModel,
        output: [],
        output_text: '',
      };
      responseSend('response.created', { type: 'response.created', response: started });
      responseSend('response.in_progress', { type: 'response.in_progress', response: started });
    }
  };
  try {
    const responseText =
      payload.text && typeof payload.text === 'object'
        ? (payload.text as Record<string, unknown>)
        : {};
    const result = await runtime.complete({
      key,
      model,
      messages: converted.messages,
      ...(converted.instructions ? { instructions: converted.instructions } : {}),
      ...(tools ? { tools } : {}),
      ...(canonical.toolChoice !== undefined ? { toolChoice: canonical.toolChoice } : {}),
      ...(canonical.maxTokens ? { maxTokens: canonical.maxTokens } : {}),
      ...(canonical.temperature !== undefined ? { temperature: canonical.temperature } : {}),
      ...(canonical.effort ? { effort: canonical.effort } : {}),
      ...parseServiceTier(payload.service_tier),
      ...structuredOutputOptions(responseText.format),
      ...(typeof payload.parallel_tool_calls === 'boolean'
        ? { parallelToolCalls: payload.parallel_tool_calls }
        : {}),
      sessionHint,
      signal: controller.signal,
      ...ferryAttemptOptions(ferryState),
      ...(stream
        ? {
            onText: (text: string) => {
              deltas.push({ type: 'text_delta', text });
              beginStream();
              if (protocol === 'responses') {
                if (!responseMessageStarted) {
                  responseMessageStarted = true;
                  responseMessageIndex = nextOutputIndex++;
                  responseSend('response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: responseMessageIndex,
                    item: {
                      type: 'message',
                      id: `${responseId}_message`,
                      role: 'assistant',
                      status: 'in_progress',
                      content: [],
                    },
                  });
                  responseSend('response.content_part.added', {
                    type: 'response.content_part.added',
                    item_id: `${responseId}_message`,
                    output_index: responseMessageIndex,
                    content_index: 0,
                    part: { type: 'output_text', text: '', annotations: [] },
                  });
                }
                responseSend('response.output_text.delta', {
                  type: 'response.output_text.delta',
                  item_id: `${responseId}_message`,
                  output_index: responseMessageIndex,
                  content_index: 0,
                  delta: text,
                });
              } else {
                res.write(
                  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\n\n`,
                );
              }
            },
            onToolCall: (call: NonNullable<GatewayCompletion['toolCalls']>[number]) => {
              calls.push(call);
              streamedCallIds.add(call.id);
              beginStream();
              if (protocol === 'responses') {
                const outputIndex = nextOutputIndex++;
                callOutputIndexes.set(call.id, outputIndex);
                responseSend('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: outputIndex,
                  item: {
                    type: 'function_call',
                    id: call.id,
                    call_id: call.id,
                    name: call.name,
                    arguments: '',
                    status: 'in_progress',
                  },
                });
                responseSend('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  item_id: call.id,
                  output_index: outputIndex,
                  delta: call.arguments,
                });
              } else {
                res.write(
                  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: call.id, name: call.name, args: parseArguments(call.arguments) } }] }, index: 0 }] })}\n\n`,
                );
              }
            },
          }
        : {}),
    });
    observeCompletion(ferryState, result);
    if (stream) beginStream(result);
    reservation?.release();
    const usage = completionUsage(result);
    runtime.store.recordUsage(
      key.id,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      new Date().toISOString(),
      usage.cachedTokens ?? 0,
      usage.reported,
    );
    const allCalls = result.toolCalls?.length ? result.toolCalls : calls;
    if (protocol === 'responses') {
      if (result.text && responseMessageIndex === undefined)
        responseMessageIndex = nextOutputIndex++;
      for (const call of allCalls)
        if (!callOutputIndexes.has(call.id)) callOutputIndexes.set(call.id, nextOutputIndex++);
      const output = [
        ...(result.text
          ? [
              {
                type: 'message',
                id: `${responseId}_message`,
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: result.text, annotations: [] }],
              },
            ]
          : []),
        ...allCalls.map((call) => ({
          type: 'function_call',
          id: call.id,
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'completed',
        })),
        ...(result.reasoning
          ? [
              {
                type: 'reasoning',
                id: `${responseId}_reasoning`,
                summary: [{ type: 'summary_text', text: result.reasoning }],
              },
            ]
          : []),
      ];
      if (stream)
        output.sort(
          (a, b) =>
            (a.type === 'message'
              ? (responseMessageIndex ?? 0)
              : (callOutputIndexes.get(a.id) ?? nextOutputIndex)) -
            (b.type === 'message'
              ? (responseMessageIndex ?? 0)
              : (callOutputIndexes.get(b.id) ?? nextOutputIndex)),
        );
      const responseBody = {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        error: null,
        incomplete_details: null,
        model: originalModel,
        output,
        output_text: result.text,
        parallel_tool_calls: payload.parallel_tool_calls !== false,
        ...responsesUsage(usage),
      };
      if (!stream) {
        json(res, 200, responseBody, ferryMetadata(ferryState, result));
        return;
      }
      if (!deltas.length && result.text) {
        responseMessageStarted = true;
        responseMessageIndex ??= nextOutputIndex++;
        responseSend('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: responseMessageIndex,
          item: {
            type: 'message',
            id: `${responseId}_message`,
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        });
        responseSend('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: `${responseId}_message`,
          output_index: responseMessageIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        responseSend('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: `${responseId}_message`,
          output_index: responseMessageIndex,
          content_index: 0,
          delta: result.text,
        });
      }
      allCalls.forEach((call) => {
        if (streamedCallIds.has(call.id)) return;
        const outputIndex = callOutputIndexes.get(call.id) ?? 0;
        responseSend('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            type: 'function_call',
            id: call.id,
            call_id: call.id,
            name: call.name,
            arguments: '',
            status: 'in_progress',
          },
        });
        responseSend('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: call.id,
          output_index: outputIndex,
          delta: call.arguments,
        });
      });
      const messageOutputIndex = responseMessageIndex ?? 0;
      if (result.text) {
        responseSend('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: `${responseId}_message`,
          output_index: messageOutputIndex,
          content_index: 0,
          text: result.text,
        });
        responseSend('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: `${responseId}_message`,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: result.text, annotations: [] },
        });
        responseSend('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: messageOutputIndex,
          item: output[messageOutputIndex],
        });
      }
      allCalls.forEach((call) => {
        const outputIndex = callOutputIndexes.get(call.id) ?? 0;
        responseSend('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: call.id,
          output_index: outputIndex,
          arguments: call.arguments,
        });
        responseSend('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item: output[outputIndex],
        });
      });
      if (result.reasoning)
        responseSend('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: output.length - 1,
          item: {
            type: 'reasoning',
            id: `${responseId}_reasoning`,
            summary: [],
            status: 'in_progress',
          },
        });
      if (result.reasoning)
        responseSend('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: `${responseId}_reasoning`,
          output_index: output.length - 1,
          summary_index: 0,
          delta: result.reasoning,
        });
      if (result.reasoning)
        responseSend('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: output.length - 1,
          item: output.at(-1),
        });
      const final = finalizeCanonicalStream([], result.finishReason, {
        inputTokens: usage.inputTokens ?? 0,
        ...(usage.cachedTokens === null ? {} : { cachedTokens: usage.cachedTokens }),
        outputTokens: usage.outputTokens ?? 0,
      });
      responseSend('response.completed', {
        type: 'response.completed',
        response: { ...responseBody, status: 'completed', finish_reason: final.finishReason },
      });
      res.end();
      return;
    }
    const candidate = {
      content: {
        role: 'model',
        parts: [
          ...(result.text ? [{ text: result.text }] : []),
          ...allCalls.map((call) => ({
            functionCall: { id: call.id, name: call.name, args: parseArguments(call.arguments) },
          })),
        ],
      },
      finishReason: allCalls.length ? 'STOP' : 'STOP',
      index: 0,
    };
    const usageFields = geminiUsage(usage);
    if (!stream) {
      json(
        res,
        200,
        { candidates: [candidate], ...usageFields, modelVersion: originalModel },
        ferryMetadata(ferryState, result),
      );
      return;
    }
    if (!deltas.length && result.text)
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: result.text }] }, index: 0 }] })}\n\n`,
      );
    const final = finalizeCanonicalStream(deltas, result.finishReason, {
      inputTokens: usage.inputTokens ?? 0,
      ...(usage.cachedTokens === null ? {} : { cachedTokens: usage.cachedTokens }),
      outputTokens: usage.outputTokens ?? 0,
    });
    res.write(
      `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP', index: 0 }], ...usageFields, modelVersion: originalModel, finishReason: final.finishReason })}\n\n`,
    );
    res.end();
  } catch (error) {
    reservation?.release();
    const mapped = mappedFailure(error);
    if (res.headersSent) {
      if (protocol === 'responses')
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: mapped.message, type: mapped.type, code: mapped.code } })}\n\n`,
        );
      else
        res.write(
          `data: ${JSON.stringify({ error: { code: mapped.status, status: mapped.type, message: mapped.message } })}\n\n`,
        );
      res.end();
    } else protocolError(res, protocol, mapped.status, mapped.message);
  }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  if (options.allowLan && !options.allowLanConfirmed)
    throw new Error('LAN gateway binding requires explicit confirmation');
  const host = options.allowLan ? '0.0.0.0' : '127.0.0.1';
  const queue = new GatewayQueue(options.concurrency, options.queueCapacity);
  const running = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  const reservedTokens = new Map<string, { minute: number; day: number }>();
  const reserveTokens = (key: GatewayKey, tokens: number) => {
    const now = new Date();
    const persisted = options.runtime.store.tokenUsage(key.id, now.toISOString());
    const reserved = reservedTokens.get(key.id) ?? { minute: 0, day: 0 };
    const perMinute = persisted.minuteTokens + reserved.minute;
    const perDay = persisted.dayTokens + reserved.day;
    const exceededMinute =
      key.tokenLimitPerMinute !== null && perMinute + tokens > key.tokenLimitPerMinute;
    const exceededDay = key.tokenLimitPerDay !== null && perDay + tokens > key.tokenLimitPerDay;
    if (exceededMinute || exceededDay) {
      return {
        retryAfter: exceededMinute ? 60 : secondsToUtcDayReset(now),
        release: () => undefined,
      };
    }
    reservedTokens.set(key.id, { minute: reserved.minute + tokens, day: reserved.day + tokens });
    let released = false;
    return {
      retryAfter: null,
      release: () => {
        if (released) return;
        released = true;
        const current = reservedTokens.get(key.id);
        if (!current) return;
        const next = {
          minute: Math.max(0, current.minute - tokens),
          day: Math.max(0, current.day - tokens),
        };
        if (next.minute === 0 && next.day === 0) reservedTokens.delete(key.id);
        else reservedTokens.set(key.id, next);
      },
    };
  };
  const failedAuth = new Map<string, number[]>();
  const loopback = (address: string | undefined) =>
    address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  const authenticate = (req: IncomingMessage): GatewayKey | undefined => {
    const internalToken = req.headers['x-ferry-internal-token'];
    if (typeof internalToken === 'string' && loopback(req.socket.remoteAddress)) {
      const grant = options.internalTokens?.get(internalToken);
      if (grant) {
        if (grant.expiresAt <= Date.now()) options.internalTokens?.delete(internalToken);
        else {
          const key = options.runtime.store
            .list()
            .find((key) => key.id === grant.keyId && !key.revokedAt);
          return key
            ? {
                ...key,
                ...(grant.testCostCapUsd === undefined
                  ? {}
                  : { requestCostCapUsd: grant.testCostCapUsd }),
              }
            : undefined;
        }
      }
    }
    const token = bearer(req);
    return token ? authenticateGatewayKey(token, options.runtime.store.list()) : undefined;
  };
  const rejectBrowserOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!req.headers.origin) return false;
    json(res, 403, errorBody('Browser origins are not allowed by the Ferry gateway', 'forbidden'));
    return true;
  };
  const badAuthentication = (req: IncomingMessage, res: ServerResponse, protocol?: Protocol) => {
    const address = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const recent = (failedAuth.get(address) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 5) {
      res.setHeader('retry-after', '60');
      if (protocol)
        protocolError(res, protocol, 429, 'Too many failed gateway authentication attempts');
      else
        json(
          res,
          429,
          errorBody('Too many failed gateway authentication attempts', 'rate_limit_error'),
        );
      return;
    }
    recent.push(now);
    failedAuth.set(address, recent);
    if (protocol) protocolError(res, protocol, 401, 'Invalid or revoked Ferry gateway key');
    else
      json(
        res,
        401,
        errorBody(
          'Invalid or revoked Ferry gateway key',
          'authentication_error',
          'gateway_authentication',
        ),
      );
  };
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const now = Date.now();
    pruneRateState(failedAuth, now);
    if (rejectBrowserOrigin(req, res)) return;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, service: 'ferry-gateway' });
      return;
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1beta/models')) {
      const key = authenticate(req);
      if (!key) {
        badAuthentication(req, res);
        return;
      }
      failedAuth.delete(req.socket.remoteAddress ?? 'unknown');
      options.runtime.store.touch(key.id, new Date().toISOString());
      const availableModels = await options.runtime.models(key);
      const ids = [
        ...(
          await Promise.all(
            Object.entries(aliases).map(async ([alias, profile]) =>
              (key.allowedModels.length === 0 ||
                key.allowedModels.includes(alias) ||
                (alias === 'ferry/auto' &&
                  key.profile !== 'none' &&
                  key.allowedModels.every(
                    (ref) => ref.includes('/') && !ref.startsWith('ferry/'),
                  ))) &&
              (await options.runtime.models(key, alias === 'ferry/auto' ? key.profile : profile))
                .length > 0
                ? alias
                : null,
            ),
          )
        ).filter((id): id is string => id !== null),
        ...availableModels.filter(
          (id) => key.allowedModels.length === 0 || key.allowedModels.includes(id),
        ),
      ];
      if (path === '/v1beta/models') {
        json(res, 200, {
          models: ids.map((id) => ({
            name: `models/${id}`,
            displayName: id,
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          })),
        });
        return;
      }
      json(res, 200, {
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'ferry' })),
      });
      return;
    }
    const geminiRoute = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(
      path,
    );
    const protocol: Protocol | undefined =
      path === '/v1/responses' ? 'responses' : geminiRoute ? 'gemini' : undefined;
    if (
      req.method === 'POST' &&
      (path === '/v1/chat/completions' || path === '/v1/messages' || protocol !== undefined)
    ) {
      const key = authenticate(req);
      if (!key) {
        badAuthentication(req, res, protocol);
        return;
      }
      failedAuth.delete(req.socket.remoteAddress ?? 'unknown');
      if (key.rateLimit !== null) {
        if (
          options.runtime.store.recentRequests(key.id, new Date().toISOString()) >= key.rateLimit
        ) {
          res.setHeader('retry-after', '60');
          json(
            res,
            429,
            path === '/v1/messages'
              ? anthropicError('Ferry gateway key rate limit exceeded', 'rate_limit_error')
              : protocol === 'responses'
                ? errorBody('Ferry gateway key rate limit exceeded', 'rate_limit_error')
                : protocol === 'gemini'
                  ? {
                      error: {
                        code: 429,
                        status: 'RESOURCE_EXHAUSTED',
                        message: 'Ferry gateway key rate limit exceeded',
                      },
                    }
                  : errorBody('Ferry gateway key rate limit exceeded', 'rate_limit_error'),
          );
          return;
        }
      }
      const controller = new AbortController();
      requestControllers.set(req, controller);
      running.add(controller);
      const timer = setTimeout(() => {
        controller.abort(
          Object.assign(new Error('Gateway request deadline reached, including queue time.'), {
            code: 'request_timeout',
            statusCode: 504,
          }),
        );
      }, options.requestDeadlineMs ?? 150_000);
      const disconnected = () => {
        if (!res.writableEnded) controller.abort(new Error('Client disconnected.'));
      };
      res.once('close', disconnected);
      req.once('aborted', disconnected);
      let release: (() => void) | undefined;
      const runtime: GatewayRuntime = {
        ...options.runtime,
        complete: (input) =>
          abortable(controller.signal, () =>
            options.runtime.complete({
              ...input,
              receivedAt: requestAt,
              queueWaitMs: Math.max(0, Date.now() - Date.parse(requestAt)),
              ...(input.onText
                ? {
                    onText: async (delta) => {
                      await input.onText?.(delta);
                      await waitForDrain(res, controller.signal);
                    },
                  }
                : {}),
              ...(input.onToolCall
                ? {
                    onToolCall: async (call) => {
                      await input.onToolCall?.(call);
                      await waitForDrain(res, controller.signal);
                    },
                  }
                : {}),
            }),
          ),
      };
      const requestAt = new Date().toISOString();
      options.runtime.store.recordRequest(key.id, requestAt);
      try {
        release = await queue.acquire(key.id, key.concurrencyLimit ?? 4, controller.signal);
        const storedKey = options.runtime.store
          .list()
          .find((entry) => entry.id === key.id && !entry.revokedAt);
        const currentKey = storedKey
          ? {
              ...storedKey,
              ...(key.requestCostCapUsd === undefined
                ? {}
                : { requestCostCapUsd: key.requestCostCapUsd }),
            }
          : undefined;
        if (!currentKey) {
          badAuthentication(req, res, protocol);
          return;
        }
        options.runtime.store.touch(key.id, new Date().toISOString());
        if (protocol)
          await handleCanonicalProtocol(
            req,
            res,
            runtime,
            currentKey,
            protocol,
            protocol === 'gemini' ? decodeURIComponent(geminiRoute?.[1] ?? '') : undefined,
            geminiRoute?.[2] === 'streamGenerateContent' ||
              new URL(req.url ?? '/', 'http://localhost').searchParams.get('alt') === 'sse',
            reserveTokens,
          );
        else if (path === '/v1/messages')
          await handleAnthropic(req, res, runtime, currentKey, reserveTokens);
        else await handleChat(req, res, runtime, currentKey, reserveTokens);
      } catch (error) {
        if (!release)
          options.runtime.rejected?.({
            key,
            at: requestAt,
            traceId: `ferry_${randomBytes(12).toString('hex')}`,
            code: controller.signal.aborted ? 'cancelled' : mappedFailure(error).code,
            durationMs: Math.max(0, Date.now() - Date.parse(requestAt)),
          });
        if (!res.destroyed && !res.writableEnded) {
          const mapped = mappedFailure(error);
          if (!res.headersSent) {
            res.setHeader('retry-after', '1');
            json(res, mapped.status, errorBody(mapped.message, mapped.type, mapped.code));
          } else res.destroy();
        }
      } finally {
        release?.();
        clearTimeout(timer);
        running.delete(controller);
        res.off('close', disconnected);
        req.off('aborted', disconnected);
      }
      return;
    }
    json(res, 404, errorBody('Not found', 'not_found'));
  };
  const server: Server = createServer((req, res) => {
    const task = handleRequest(req, res).catch(() => {
      if (!res.destroyed) res.destroy();
    });
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  });
  const wantedPort = options.port ?? 11435;
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListen);
      if (error.code === 'EADDRINUSE' && wantedPort !== 0) {
        server.removeListener('error', onError);
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(0, host);
        return;
      }
      reject(error);
    };
    const onListen = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Gateway failed to bind'));
      else resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(wantedPort, host);
  });
  return {
    port,
    host,
    activity: () => queue.state,
    close: async () => {
      queue.close();
      for (const controller of running) controller.abort(new Error('Gateway shutting down.'));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
      await Promise.allSettled([...tasks]);
    },
  };
}
