import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, type LanguageModel } from 'ai';
import { loadCatalog } from '@ferry/catalog';
import {
  ProviderIdSchema,
  RawCallObservationSchema,
  UsageRecordSchema,
  type ModelRef,
  type ProbeResult,
  type ProviderErrorKind,
  type ProviderId,
  type QuotaObservation,
  type RawCallObservation,
  type UsageRecord,
} from '@ferry/shared';
export type {
  ProbeResult,
  ProviderErrorKind,
  QuotaObservation,
  RawCallObservation,
  UsageRecord,
} from '@ferry/shared';

export const PACKAGE = '@ferry/providers';
const FERRY_VERSION = '0.0.0';
const providerCatalogData = await loadCatalog();

export interface ModelFactoryOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  sessionId?: string;
}

export interface MappedProviderError {
  kind: ProviderErrorKind;
  retryAfterMs: number | null;
  message: string;
}

export interface ParsedQuotaWindow {
  windowId: string;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  confidence: 'exact';
}

export function providerFromRef(ref: ModelRef | string): string {
  return ref.slice(0, ref.indexOf('/'));
}

const compatibleDefaults: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

function defaultBaseURL(providerId: string): string {
  const catalogEndpoint = providerCatalogData.providers
    .find((provider) => provider.provider === providerId)
    ?.endpoints?.find((endpoint) => /\/(?:chat\/completions|messages)\/?$/.test(endpoint));
  const catalogBaseURL = catalogEndpoint?.replace(/\/(?:chat\/completions|messages)\/?$/, '');
  const value = catalogBaseURL ?? compatibleDefaults[providerId];
  if (!value) throw new Error(`No default base URL for ${providerId}`);
  return value;
}

function createCompatible(
  name: string,
  model: string,
  options: ModelFactoryOptions,
  baseURL: string,
  headers: Record<string, string>,
): LanguageModel {
  const provider = createOpenAICompatible({
    name,
    baseURL,
    apiKey: options.apiKey,
    headers,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return provider.chatModel(model);
}

function openCodeHeaders(opts: ModelFactoryOptions): Record<string, string> {
  return {
    ...opts.headers,
    'User-Agent': `Ferry/${FERRY_VERSION}`,
    'x-session-id': opts.sessionId ?? globalThis.crypto.randomUUID(),
  };
}

export function createLanguageModel(ref: ModelRef, opts: ModelFactoryOptions): LanguageModel {
  const providerId = providerFromRef(ref);
  const modelId = ref.slice(providerId.length + 1);
  const fetchOptions = opts.fetch ? { fetch: opts.fetch } : {};
  const headers = { ...opts.headers };

  switch (providerId) {
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: opts.apiKey, headers, ...fetchOptions })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey: opts.apiKey, headers, ...fetchOptions })(modelId);
    case 'openai':
      return createOpenAI({
        apiKey: opts.apiKey,
        headers,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
        ...fetchOptions,
      }).chat(modelId);
    case 'openrouter': {
      const openRouterHeaders = {
        ...headers,
        'HTTP-Referer': 'https://ferry.dev',
        'X-Title': 'Ferry',
      };
      return createOpenRouter({
        apiKey: opts.apiKey,
        headers: openRouterHeaders,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
        ...fetchOptions,
      })(modelId);
    }
    case 'opencode-go': {
      const baseURL = opts.baseUrl ?? defaultBaseURL(providerId);
      const requiredHeaders = openCodeHeaders(opts);
      if (/^(claude|anthropic)[-/:]/i.test(modelId)) {
        return createAnthropic({
          apiKey: opts.apiKey,
          baseURL,
          headers: requiredHeaders,
          ...fetchOptions,
        })(modelId);
      }
      return createCompatible(providerId, modelId, opts, baseURL, requiredHeaders);
    }
    case 'opencode': {
      return createCompatible(
        providerId,
        modelId,
        opts,
        opts.baseUrl ?? defaultBaseURL(providerId),
        openCodeHeaders(opts),
      );
    }
    case 'groq':
    case 'cerebras':
    case 'nvidia':
    case 'mistral':
    case 'deepseek':
      return createCompatible(
        providerId,
        modelId,
        opts,
        opts.baseUrl ?? defaultBaseURL(providerId),
        headers,
      );
    default:
      if (!opts.baseUrl)
        throw new Error(`Custom OpenAI-compatible provider ${providerId} requires baseUrl`);
      return createCompatible(providerId, modelId, opts, opts.baseUrl, headers);
  }
}

function isRateLimitHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'retry-after' || /^x-ratelimit-[a-z0-9-]+$/.test(lower);
}

function requestSize(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): number | null {
  const body = init?.body ?? (input instanceof Request ? input.body : null);
  if (body === null) return 0;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

export function createObservedFetch(
  onObservation: (observation: RawCallObservation) => void,
  defaults: { providerId?: string; model?: string } = {},
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const startedAt = Date.now();
    const started = performance.now();
    const url = input instanceof Request ? input.url : String(input);
    const match = /\/models\/([^/:?]+)/.exec(url);
    const model = defaults.model ?? decodeURIComponent(match?.[1] ?? 'unknown');
    const providerId =
      defaults.providerId ?? new URL(url, 'http://localhost').hostname.split('.')[0] ?? 'unknown';
    try {
      const response = await fetchImpl(input, init);
      const rateLimitHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (isRateLimitHeader(name)) rateLimitHeaders[name.toLowerCase()] = value;
      });
      onObservation(
        RawCallObservationSchema.parse({
          providerId: ProviderIdSchema.parse(providerId),
          modelRef: model,
          startedAt,
          latencyMs: Math.max(0, performance.now() - started),
          statusCode: response.status,
          requestBytes: requestSize(input, init),
          rateLimitHeaders,
          errorKind: response.ok ? null : mapProviderError({ status: response.status }).kind,
        }),
      );
      return response;
    } catch (error) {
      onObservation(
        RawCallObservationSchema.parse({
          providerId: ProviderIdSchema.parse(providerId),
          modelRef: model,
          startedAt,
          latencyMs: Math.max(0, performance.now() - started),
          statusCode: null,
          requestBytes: requestSize(input, init),
          rateLimitHeaders: {},
          errorKind: mapProviderError(error).kind,
        }),
      );
      throw error;
    }
  };
}

export function mergeUsage(
  observation: RawCallObservation,
  usage: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    reasoningTokens?: number | null;
    inputTokenDetails?: { cacheReadTokens?: number | null; cacheWriteTokens?: number | null };
    outputTokenDetails?: { reasoningTokens?: number | null };
  } = {},
): UsageRecord {
  const cachedTokens =
    usage.cachedInputTokens ??
    ((usage.inputTokenDetails?.cacheReadTokens ?? 0) +
      (usage.inputTokenDetails?.cacheWriteTokens ?? 0) ||
      null);
  const reasoningTokens = usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens;
  return UsageRecordSchema.parse({
    id: globalThis.crypto.randomUUID(),
    providerId: observation.providerId,
    modelRef: observation.modelRef,
    occurredAt: new Date(observation.startedAt).toISOString(),
    ...(usage.inputTokens == null ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens == null ? {} : { outputTokens: usage.outputTokens }),
    ...(cachedTokens == null ? {} : { cachedTokens }),
    ...(reasoningTokens == null ? {} : { reasoningTokens }),
    latencyMs: observation.latencyMs,
    status: observation.errorKind === null ? 'success' : 'error',
    errorKind: observation.errorKind,
  });
}

function num(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resetTime(value: string | null | undefined, now: Date): string | null {
  if (!value) return null;
  const seconds = num(value);
  const date = seconds !== null ? new Date(now.getTime() + seconds * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function retryAfterTime(value: string, now: Date): string | null {
  const seconds = num(value);
  if (seconds === null) return resetTime(value, now);
  const timestamp = now.getTime() + seconds * 1000;
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15
    ? new Date(timestamp).toISOString()
    : null;
}

function nextMidnight(now: Date, timeZone: string): string {
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const get = (type: string) => Number(local.find((part) => part.type === type)?.value ?? 0);
  let candidate = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + 1));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(candidate);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const desired = Date.UTC(get('year'), get('month') - 1, get('day') + 1);
    const represented = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'));
    candidate = new Date(candidate.getTime() + desired - represented);
  }
  return candidate.toISOString();
}

function headerQuota(
  headers: Record<string, string>,
  metric: string,
  suffix: string,
  now: Date,
  windowId: string,
): ParsedQuotaWindow | null {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const remaining = num(lower[`x-ratelimit-remaining-${metric}${suffix}`]);
  const limit = num(lower[`x-ratelimit-limit-${metric}${suffix}`]);
  const resetAt = resetTime(lower[`x-ratelimit-reset-${metric}${suffix}`], now);
  if (remaining === null && limit === null && resetAt === null) return null;
  return { windowId, remaining, limit, resetAt, confidence: 'exact' };
}

export function parseGroqRateLimits(
  headers: Record<string, string>,
  now = new Date(),
): ParsedQuotaWindow[] {
  const result = [
    headerQuota(headers, 'requests', '', now, 'requests-day'),
    headerQuota(headers, 'tokens', '', now, 'tokens-minute'),
  ].filter((entry): entry is ParsedQuotaWindow => entry !== null);
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (lower['retry-after'] && !result.some((entry) => entry.windowId === 'retry-after')) {
    result.push({
      windowId: 'retry-after',
      remaining: null,
      limit: null,
      resetAt: retryAfterTime(lower['retry-after'] ?? '', now),
      confidence: 'exact',
    });
  }
  return result;
}

export function parseOpenRouterKey(body: unknown, now = new Date()): ParsedQuotaWindow[] {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const data =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;
  const free =
    data.free_model_daily_requests && typeof data.free_model_daily_requests === 'object'
      ? (data.free_model_daily_requests as Record<string, unknown>)
      : {};
  const result: ParsedQuotaWindow[] = [];
  const remaining = typeof data.limit_remaining === 'number' ? data.limit_remaining : null;
  if (remaining !== null)
    result.push({
      windowId: 'credits',
      remaining,
      limit: null,
      resetAt: null,
      confidence: 'exact',
    });
  if (typeof free.remaining === 'number' || typeof free.limit === 'number') {
    result.push({
      windowId: 'free-model-requests-day',
      remaining: typeof free.remaining === 'number' ? free.remaining : null,
      limit: typeof free.limit === 'number' ? free.limit : null,
      resetAt: nextMidnight(now, 'UTC'),
      confidence: 'exact',
    });
  }
  return result;
}

export function parseGeminiQuota(
  body: unknown,
  now = new Date(),
  status = 429,
): ParsedQuotaWindow[] {
  if (status !== 429) return [];
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const error =
    root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : {};
  if (error.status !== 'RESOURCE_EXHAUSTED' && error.code !== 429) return [];
  const details = Array.isArray(error.details) ? error.details : [];
  const retry = details.find(
    (detail) =>
      detail &&
      typeof detail === 'object' &&
      String((detail as Record<string, unknown>)['@type']).includes('RetryInfo'),
  ) as Record<string, unknown> | undefined;
  const quota = details.find(
    (detail) =>
      detail &&
      typeof detail === 'object' &&
      String((detail as Record<string, unknown>)['@type']).includes('QuotaFailure'),
  ) as Record<string, unknown> | undefined;
  const violations = Array.isArray(quota?.violations) ? quota.violations : [];
  const candidateMetric =
    violations[0] && typeof violations[0] === 'object'
      ? (violations[0] as Record<string, unknown>).quotaMetric
      : null;
  const metric = typeof candidateMetric === 'string' ? candidateMetric : 'requests';
  const delay = typeof retry?.retryDelay === 'string' ? /([\d.]+)s/.exec(retry.retryDelay) : null;
  const retryAt = delay ? new Date(now.getTime() + Number(delay[1]) * 1000).toISOString() : null;
  const observations: ParsedQuotaWindow[] = [
    {
      windowId: `gemini:${metric}`,
      remaining: 0,
      limit: null,
      resetAt: nextMidnight(now, 'America/Los_Angeles'),
      confidence: 'exact',
    },
  ];
  if (retryAt) {
    observations.push({
      windowId: 'gemini:retry-after',
      remaining: null,
      limit: null,
      resetAt: retryAt,
      confidence: 'exact',
    });
  }
  return observations;
}

const CEREBRAS_WINDOWS = [
  { pattern: /requests?.*(day|daily)|(?:day|daily).*requests?/, id: 'requests-day' },
  { pattern: /requests?.*(minute|min)|(?:minute|min).*requests?/, id: 'requests-minute' },
  { pattern: /tokens?.*(day|daily)|(?:day|daily).*tokens?/, id: 'tokens-day' },
  { pattern: /tokens?.*(minute|min)|(?:minute|min).*tokens?/, id: 'tokens-minute' },
] as const;

export function parseCerebrasRateLimits(
  headers: Record<string, string>,
  now = new Date(),
): ParsedQuotaWindow[] {
  const values = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const output: ParsedQuotaWindow[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith('x-ratelimit-')) continue;
    const match = /^x-ratelimit-(limit|remaining|reset)-(.+)$/.exec(key);
    if (!match) continue;
    const dimension = match[2] ?? '';
    const window = CEREBRAS_WINDOWS.find((candidate) => candidate.pattern.test(dimension));
    if (!window) continue;
    const prior = output.find((entry) => entry.windowId === window.id);
    const entry = prior ?? {
      windowId: window.id,
      remaining: null,
      limit: null,
      resetAt: null,
      confidence: 'exact' as const,
    };
    if (match[1] === 'limit') entry.limit = num(value);
    if (match[1] === 'remaining') entry.remaining = num(value);
    if (match[1] === 'reset') entry.resetAt = resetTime(value, now);
    if (!prior) output.push(entry);
  }
  return output;
}

export function parseGenericRateLimits(
  headers: Record<string, string>,
  now = new Date(),
): ParsedQuotaWindow[] {
  const values = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const output: ParsedQuotaWindow[] = [];
  const keys = new Set([...Object.keys(values).filter((key) => key.startsWith('x-ratelimit-'))]);
  const dimensions = [...keys]
    .map((key) => key.replace(/^x-ratelimit-(?:limit|remaining|reset)-?/, ''))
    .filter(Boolean);
  const unique = [...new Set(dimensions)];
  if ([...keys].some((key) => /^x-ratelimit-(?:limit|remaining|reset)$/.test(key)))
    unique.unshift('default');
  for (const dimension of unique.length ? unique : ['default']) {
    const suffix = dimension === 'default' ? '' : `-${dimension}`;
    const limit = num(values[`x-ratelimit-limit${suffix}`]);
    const remaining = num(values[`x-ratelimit-remaining${suffix}`]);
    const resetAt = resetTime(values[`x-ratelimit-reset${suffix}`], now);
    if (limit !== null || remaining !== null || resetAt !== null)
      output.push({
        windowId: `generic:${dimension}`,
        limit,
        remaining,
        resetAt,
        confidence: 'exact',
      });
  }
  if (values['retry-after']) {
    output.push({
      windowId: 'retry-after',
      remaining: null,
      limit: null,
      resetAt: retryAfterTime(values['retry-after'], now),
      confidence: 'exact',
    });
  }
  return output;
}

export function parseQuota(
  parserId: string | null | undefined,
  input: { headers?: Record<string, string>; body?: unknown; status?: number; now?: Date },
): ParsedQuotaWindow[] {
  const now = input.now ?? new Date();
  switch (parserId) {
    case 'groq_rate_limit_headers':
      return parseGroqRateLimits(input.headers ?? {}, now);
    case 'openrouter_key':
      return parseOpenRouterKey(input.body, now);
    case 'gemini_retry_info':
      return parseGeminiQuota(input.body, now, input.status ?? 429);
    case 'cerebras_rate_limit_headers':
      return parseCerebrasRateLimits(input.headers ?? {}, now);
    case 'generic':
    case null:
    case undefined:
      return parseGenericRateLimits(input.headers ?? {}, now);
    default:
      return [];
  }
}

export function parserIdForProvider(providerId: string, catalogParser?: string | null): string {
  if (catalogParser) return catalogParser;
  return providerId === 'cerebras' ? 'cerebras_rate_limit_headers' : 'generic';
}

export function mapProviderError(error: unknown): MappedProviderError {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const response =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : {};
  const status = Number(record.statusCode ?? record.status ?? response.status ?? 0);
  const message =
    typeof record.message === 'string'
      ? record.message
      : error instanceof Error
        ? error.message
        : 'Provider request failed';
  const code = typeof record.code === 'string' ? record.code.toLowerCase() : '';
  const rawRetry =
    record.retryAfter ?? readRetryAfter(response.headers) ?? readRetryAfter(record.responseHeaders);
  const retry = Number(rawRetry);
  const retryAfterMs =
    Number.isFinite(retry) && retry > 0
      ? retry * 1000
      : typeof rawRetry === 'string' && Number.isFinite(Date.parse(rawRetry))
        ? Math.max(0, Date.parse(rawRetry) - Date.now())
        : null;
  let kind: ProviderErrorKind;
  if (
    code.includes('timeout') ||
    code.includes('timedout') ||
    code.includes('aborted') ||
    /timed?\s*out|timeout/i.test(message) ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
    kind = 'timeout';
  else if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|authentication/i.test(message)
  )
    kind = 'auth';
  else if (status === 429 || /rate.limit/i.test(message))
    kind = /quota|resource_exhausted|daily limit/i.test(message) ? 'quota_exhausted' : 'rate_limit';
  else if (/context.length|maximum context|too many tokens/i.test(message))
    kind = 'context_overflow';
  else if (status >= 500) kind = 'server';
  else if (status >= 400) kind = 'bad_request';
  else kind = 'network';
  return { kind, retryAfterMs, message: friendlyError(kind, retryAfterMs) };
}

function readRetryAfter(headers: unknown): string | number | null {
  if (headers instanceof Headers) return headers.get('retry-after');
  if (!headers || typeof headers !== 'object') return null;
  const values = headers as Record<string, unknown>;
  const value = values['retry-after'] ?? values['Retry-After'];
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function friendlyError(kind: ProviderErrorKind, retryAfterMs: number | null): string {
  if (kind === 'auth') return 'Key invalid';
  if (kind === 'rate_limit' || kind === 'quota_exhausted') {
    if (retryAfterMs !== null) {
      const totalMinutes = Math.ceil(retryAfterMs / 60000);
      return `Rate limited — resets in ${String(Math.floor(totalMinutes / 60))}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
    }
    return kind === 'quota_exhausted' ? 'Quota exhausted' : 'Rate limited';
  }
  if (kind === 'context_overflow') return 'Prompt exceeds the model context limit';
  if (kind === 'timeout') return 'Provider request timed out';
  if (kind === 'network') return 'Could not reach provider';
  if (kind === 'server') return 'Provider is unavailable';
  return 'Provider rejected the request';
}

export interface ProbeOptions {
  modelRef?: ModelRef;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sessionId?: string;
}

function providerCatalog(): ReturnType<typeof loadCatalog> {
  return Promise.resolve(providerCatalogData);
}

export async function probe(
  providerId: ProviderId | string,
  key: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const started = performance.now();
  const observations: RawCallObservation[] = [];
  try {
    const catalog = await providerCatalog();
    const modelInfo = options.modelRef
      ? catalog.models.find((model) => model.ref === options.modelRef)
      : catalog.models.find((model) => model.providerId === providerId);
    if (!modelInfo) throw new Error(`No catalog model found for ${providerId}`);
    let openRouterSnapshot: ParsedQuotaWindow[] = [];
    if (providerId === 'openrouter') {
      const configured = (options.baseUrl ?? 'https://openrouter.ai').replace(/\/$/, '');
      const origin = configured.endsWith('/api/v1') ? configured.slice(0, -7) : configured;
      const response = await (options.fetch ?? globalThis.fetch)(`${origin}/api/v1/key`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error('OpenRouter key check failed'), {
          statusCode: response.status,
          responseHeaders: response.headers,
        });
      }
      openRouterSnapshot = parseOpenRouterKey(payload);
    }
    const observedFetch = createObservedFetch(
      (observation) => observations.push(observation),
      { providerId, model: modelInfo.ref.slice(String(providerId).length + 1) },
      options.fetch ?? globalThis.fetch,
    );
    const languageModel = createLanguageModel(modelInfo.ref, {
      apiKey: key,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      fetch: observedFetch,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
    await generateText({
      model: languageModel,
      prompt: 'Reply with one character.',
      maxOutputTokens: 1,
      maxRetries: 0,
    });
    const parser = parserIdForProvider(
      String(providerId),
      catalog.providers.find((provider) => provider.provider === providerId)?.parser,
    );
    const headers = observations[observations.length - 1]?.rateLimitHeaders ?? {};
    const observedAt = new Date().toISOString();
    const quotaObservations = toQuotaObservations(
      [...openRouterSnapshot, ...parseQuota(parser, { headers })],
      {
        providerId: ProviderIdSchema.parse(providerId),
        source: openRouterSnapshot.length ? 'endpoint' : 'header',
        observedAt,
        statusCode: observations.at(-1)?.statusCode ?? undefined,
      },
    );
    const windows = quotaWindows(quotaObservations);
    const catalogModels = catalog.models
      .filter((model) => model.providerId === providerId)
      .map((model) => model.ref.slice(String(providerId).length + 1));
    const models = await listProviderModels(
      String(providerId),
      key,
      options,
      options.fetch ?? globalThis.fetch,
    ).catch(() => catalogModels);
    return {
      ok: true,
      keyValid: true,
      latencyMs: Math.max(0, performance.now() - started),
      message: 'Key valid',
      windows,
      models: models.length ? models : catalogModels,
      errorKind: null,
    };
  } catch (error) {
    const latestObservation = observations.at(-1);
    const latestHeaders = latestObservation?.rateLimitHeaders ?? {};
    const retryAfter = latestHeaders['retry-after'];
    const enrichedError =
      error && typeof error === 'object'
        ? {
            ...(error as Record<string, unknown>),
            ...(retryAfter ? { retryAfter } : {}),
            ...(latestObservation?.statusCode ? { statusCode: latestObservation.statusCode } : {}),
          }
        : latestObservation?.statusCode
          ? { statusCode: latestObservation.statusCode, retryAfter, message: String(error) }
          : error;
    const mapped = mapProviderError(enrichedError);
    const catalog = await providerCatalog();
    const status =
      latestObservation?.statusCode ??
      Number(
        error && typeof error === 'object' ? (error as Record<string, unknown>).statusCode : 0,
      );
    const parsedWindows = parseQuota(
      parserIdForProvider(
        String(providerId),
        catalog.providers.find((provider) => provider.provider === providerId)?.parser,
      ),
      {
        headers: latestHeaders,
        ...(Number.isFinite(status) && status > 0 ? { status } : {}),
      },
    );
    const failedObservations = toQuotaObservations(parsedWindows, {
      providerId: ProviderIdSchema.parse(providerId),
      source: 'header',
      observedAt: new Date().toISOString(),
      statusCode: Number.isFinite(status) && status > 0 ? status : undefined,
    });
    return {
      ok: false,
      keyValid: mapped.kind !== 'auth',
      latencyMs: Math.max(0, performance.now() - started),
      message: mapped.message,
      windows: quotaWindows(failedObservations),
      models: [],
      errorKind: mapped.kind,
    };
  }
}

async function listProviderModels(
  providerId: string,
  key: string,
  options: ProbeOptions,
  fetchImpl: typeof globalThis.fetch,
): Promise<string[]> {
  let baseURL: string | undefined;
  if (providerId === 'openai') baseURL = options.baseUrl ?? 'https://api.openai.com/v1';
  else if (providerId === 'openrouter') baseURL = options.baseUrl ?? 'https://openrouter.ai/api/v1';
  else if (compatibleDefaults[providerId])
    baseURL = options.baseUrl ?? compatibleDefaults[providerId];
  else if (options.baseUrl) baseURL = options.baseUrl;
  if (!baseURL) return [];
  const response = await fetchImpl(`${baseURL.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) return [];
  const payload: unknown = await response.json().catch(() => ({}));
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === 'string' ? [id] : [];
  });
}

function toQuotaObservations(
  windows: ParsedQuotaWindow[],
  details: {
    providerId: ProviderId;
    source: QuotaObservation['source'];
    observedAt: string;
    statusCode: number | undefined;
  },
): QuotaObservation[] {
  return windows.map((window) => ({
    id: globalThis.crypto.randomUUID(),
    providerId: details.providerId,
    windowId: window.windowId,
    metric: window.windowId.includes('token')
      ? 'tokens'
      : window.windowId === 'credits'
        ? 'credits'
        : 'requests',
    ...(window.limit === null || window.remaining === null
      ? {}
      : { value: Math.max(0, window.limit - window.remaining) }),
    limit: window.limit,
    remaining: window.remaining,
    resetAt: window.resetAt,
    source: details.source,
    observedAt: details.observedAt,
    ...(details.statusCode === undefined ? {} : { statusCode: details.statusCode }),
  }));
}

function quotaWindows(observations: QuotaObservation[]): ProbeResult['windows'] {
  return observations.map((window) => {
    const limit = window.limit ?? null;
    const remaining = window.remaining ?? null;
    const kind = /daily|day/i.test(window.windowId)
      ? 'fixed_daily'
      : /minute|second/i.test(window.windowId)
        ? 'rolling'
        : /weekly|week/i.test(window.windowId)
          ? 'weekly'
          : /monthly|month/i.test(window.windowId)
            ? 'monthly'
            : 'dynamic';
    return {
      id: window.windowId,
      scope: 'provider' as const,
      modelRef: null,
      metric: window.metric,
      kind,
      periodLabel: window.windowId,
      used:
        window.value ?? (limit !== null && remaining !== null ? Math.max(0, limit - remaining) : 0),
      limit,
      remaining,
      resetAt: window.resetAt ?? null,
      confidence: 'exact' as const,
    };
  });
}
