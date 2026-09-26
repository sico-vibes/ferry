import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, type LanguageModel } from 'ai';
import { loadCatalog } from '@ferry/catalog';
import {
  ProviderIdSchema,
  ModelInfoSchema,
  RawCallObservationSchema,
  UsageRecordSchema,
  type ModelRef,
  type ModelInfo,
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

function redactSecrets(value: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value);
}

const compatibleDefaults: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  llm7: 'https://api.llm7.io/v1',
  'vercel-ai-gateway': 'https://ai-gateway.vercel.sh/v1',
  huggingface: 'https://router.huggingface.co/v1',
  kilo: 'https://api.kilo.ai/api/gateway',
  ovhcloud: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  tokenrouter: 'https://api.tokenrouter.com/v1',
  anyapi: 'https://api.anyapi.ai/v1',
  'zai-glm': 'https://api.z.ai/api/paas/v4',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  nebius: 'https://api.studio.nebius.com/v1',
  scaleway: 'https://api.scaleway.ai/v1',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  novita: 'https://api.novita.ai/v3/openai',
  together: 'https://api.together.xyz/v1',
  stepfun: 'https://api.stepfun.ai/v1',
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
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
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
      return createCompatible(
        providerId,
        modelId,
        opts,
        opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
        headers,
      );
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
    case 'sambanova':
    case 'llm7':
    case 'cloudflare-workers-ai':
    case 'kilo':
    case 'vercel-ai-gateway':
    case 'huggingface':
    case 'ovhcloud':
    case 'tokenrouter':
    case 'anyapi':
    case 'zai-glm':
    case 'fireworks':
    case 'nebius':
    case 'scaleway':
    case 'hyperbolic':
    case 'deepinfra':
    case 'novita':
    case 'together':
    case 'stepfun':
      return createCompatible(
        providerId,
        providerId === 'nvidia' && !modelId.includes('/') ? `nvidia/${modelId}` : modelId,
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
  const duration =
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i.exec(
      value.trim(),
    );
  if (duration?.slice(1).some(Boolean)) {
    const milliseconds =
      Number(duration[1] ?? 0) * 3_600_000 +
      Number(duration[2] ?? 0) * 60_000 +
      Number(duration[3] ?? 0) * 1_000 +
      Number(duration[4] ?? 0);
    return new Date(now.getTime() + milliseconds).toISOString();
  }
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
  const limit = num(lower[`x-ratelimit-limit-${metric}${suffix}`]);
  const reportedRemaining = num(lower[`x-ratelimit-remaining-${metric}${suffix}`]);
  const remaining =
    reportedRemaining !== null && limit !== null
      ? Math.min(reportedRemaining, limit)
      : reportedRemaining;
  const resetAt = resetTime(lower[`x-ratelimit-reset-${metric}${suffix}`], now);
  if (remaining === null && limit === null && resetAt === null) return null;
  return { windowId, remaining, limit, resetAt, confidence: 'exact' };
}

export function parseGroqRateLimits(
  headers: Record<string, string>,
  now = new Date(),
): ParsedQuotaWindow[] {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const result: ParsedQuotaWindow[] = [];
  for (const [metric, windows] of [
    ['requests', ['day', 'hour', 'minute']],
    ['tokens', ['day', 'hour', 'minute']],
  ] as const) {
    for (const window of windows) {
      const entry = headerQuota(headers, metric, `-${window}`, now, `${metric}-${window}`);
      if (entry) result.push(entry);
    }
  }
  if (!result.length) {
    result.push(
      ...[
        headerQuota(headers, 'requests', '', now, 'requests'),
        headerQuota(headers, 'tokens', '', now, 'tokens'),
      ]
        .filter((entry): entry is ParsedQuotaWindow => entry !== null)
        .map((entry) => ({
          ...entry,
          windowId: entry.windowId === 'requests' ? 'requests-day' : 'tokens-minute',
        })),
    );
  }
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
  if (remaining !== null && !(data.is_free_tier === true && remaining === 0))
    result.push({
      windowId: 'credits',
      remaining,
      limit: null,
      resetAt: null,
      confidence: 'exact',
    });
  if (
    data.is_free_tier === true ||
    typeof free.remaining === 'number' ||
    typeof free.limit === 'number'
  ) {
    const dailyLimit =
      typeof free.limit === 'number' ? free.limit : data.is_free_tier === true ? 50 : 1000;
    result.push({
      windowId: 'free-model-requests-day',
      remaining: typeof free.remaining === 'number' ? free.remaining : dailyLimit,
      limit: dailyLimit,
      resetAt: nextMidnight(now, 'UTC'),
      confidence: 'exact',
    });
  }
  return result;
}

function parseGeminiQuotaUnsafe(
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
  const retrySeconds = delay ? Number(delay[1]) : NaN;
  const retryDate = Number.isFinite(retrySeconds)
    ? new Date(now.getTime() + Math.min(retrySeconds, 365 * 86400) * 1000)
    : null;
  const retryAt =
    retryDate && Number.isFinite(retryDate.getTime()) ? retryDate.toISOString() : null;
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

export function parseGeminiQuota(
  body: unknown,
  now = new Date(),
  status = 429,
): ParsedQuotaWindow[] {
  try {
    return parseGeminiQuotaUnsafe(body, now, status);
  } catch {
    return [];
  }
}

const CEREBRAS_WINDOWS = [
  { pattern: /requests?.*(?:day|daily)|(?:day|daily)[-_].*requests?/, id: 'requests-day' },
  { pattern: /requests?[-_](?:hour|hourly)|(?:hour|hourly)[-_].*requests?/, id: 'requests-hour' },
  { pattern: /requests?[-_](?:minute|min)|(?:minute|min)[-_].*requests?/, id: 'requests-minute' },
  { pattern: /tokens?[-_](?:day|daily)|(?:day|daily)[-_].*tokens?/, id: 'tokens-day' },
  { pattern: /tokens?[-_](?:hour|hourly)|(?:hour|hourly)[-_].*tokens?/, id: 'tokens-hour' },
  { pattern: /tokens?[-_](?:minute|min)|(?:minute|min)[-_].*tokens?/, id: 'tokens-minute' },
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
    if (entry.limit !== null && entry.remaining !== null)
      entry.remaining = Math.min(entry.remaining, entry.limit);
    if (!prior) output.push(entry);
  }
  return output;
}

export function parseMistralRateLimits(
  headers: Record<string, string>,
  now = new Date(),
): ParsedQuotaWindow[] {
  return parseGenericRateLimits(headers, now).map((entry) => ({
    ...entry,
    windowId: entry.windowId.replace(/^generic:/, '').replace(/^req-/, 'requests-'),
  }));
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
    case 'mistral_rate_limit_headers':
      return parseMistralRateLimits(input.headers ?? {}, now);
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
  if (providerId === 'cerebras') return 'cerebras_rate_limit_headers';
  if (providerId === 'mistral') return 'mistral_rate_limit_headers';
  if (providerId === 'groq') return 'groq_rate_limit_headers';
  return 'generic';
}

function providerErrorMessage(record: Record<string, unknown>, error: unknown): string {
  const body = record.responseBody ?? record.body;
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        const root = parsed as Record<string, unknown>;
        const details =
          root.error && typeof root.error === 'object'
            ? (root.error as Record<string, unknown>)
            : root;
        if (typeof details.message === 'string') return details.message;
      }
    } catch {
      // Use the SDK's message when the response body is not JSON.
    }
  } else if (body && typeof body === 'object') {
    const root = body as Record<string, unknown>;
    const details =
      root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : root;
    if (typeof details.message === 'string') return details.message;
  }
  return typeof record.message === 'string'
    ? record.message
    : error instanceof Error
      ? error.message
      : 'Provider request failed';
}

export function mapProviderError(error: unknown): MappedProviderError {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const response =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : {};
  const status = Number(record.statusCode ?? record.status ?? response.status ?? 0);
  const message = providerErrorMessage(record, error);
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
  else if (status === 401) kind = 'auth';
  else if (status === 403 && /freetier|free tier.*only be used from within opencode/i.test(message))
    kind = 'unsupported_free_tier';
  else if (status === 403) kind = 'forbidden';
  else if (status === 404 || status === 410) kind = 'model_not_found';
  else if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|authentication/i.test(message)
  )
    kind = 'auth';
  else if (
    /tool.{0,30}(?:not supported|unsupported|not enabled)|function calling.{0,30}(?:not supported|not enabled)/i.test(
      message,
    )
  )
    kind = 'tools_unsupported';
  else if (/content_filter|safety.{0,20}blocked|content policy/i.test(message))
    kind = 'content_filter';
  else if (status === 429 || /rate.limit|resource_exhausted/i.test(message))
    kind = /quota|resource_exhausted|daily limit|billing|credits exhausted/i.test(message)
      ? 'quota_exhausted'
      : 'rate_limit';
  else if (/context.length|maximum context|too many tokens/i.test(message))
    kind = 'context_overflow';
  else if (status >= 500) kind = 'server';
  else if (status >= 400) kind = 'request_scoped_client';
  else kind = 'network';
  return { kind, retryAfterMs, message: safeProviderMessage(message, kind, retryAfterMs) };
}

function safeProviderMessage(
  message: string,
  kind: ProviderErrorKind,
  retryAfterMs: number | null,
): string {
  if (kind === 'network' || kind === 'timeout') return friendlyError(kind, retryAfterMs);
  const cleaned = message.replace(
    /(?:Bearer\s+)?(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}/gi,
    '[REDACTED]',
  );
  if (kind === 'unsupported_free_tier')
    return "Zen's free models only work inside OpenCode; Zen here needs paid balance";
  return cleaned || friendlyError(kind, retryAfterMs);
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
  if (kind === 'unsupported_free_tier')
    return "Zen's free models only work inside OpenCode; Zen here needs paid balance";
  if (kind === 'forbidden') return 'Provider denied access';
  if (kind === 'not_found') return 'Provider resource was not found';
  if (kind === 'gone') return 'Provider resource is no longer available';
  if (kind === 'network') return 'Could not reach provider';
  if (kind === 'server') return 'Provider is unavailable';
  return 'Provider rejected the request';
}

export interface ProbeOptions {
  modelRef?: ModelRef;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  probeModels?: string[];
}

function providerCatalog(): ReturnType<typeof loadCatalog> {
  return Promise.resolve(providerCatalogData);
}

async function probeWithSignal(
  providerId: ProviderId | string,
  key: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const started = performance.now();
  let apiKey = key;
  let probeOptions = options;
  if (providerId === 'cloudflare-workers-ai') {
    const credentials = (() => {
      try {
        return JSON.parse(key) as { accountId?: unknown; apiKey?: unknown };
      } catch {
        return null;
      }
    })();
    if (
      credentials &&
      typeof credentials.accountId === 'string' &&
      typeof credentials.apiKey === 'string'
    ) {
      apiKey = credentials.apiKey;
      probeOptions = {
        ...options,
        baseUrl:
          options.baseUrl ??
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/v1`,
      };
    }
  }
  const observations: RawCallObservation[] = [];
  const skippedModels: { model: string; reason: string }[] = [];
  try {
    const catalog = await providerCatalog();
    const catalogModels = catalog.models.filter((model) => model.providerId === providerId);
    const liveModels = await discoverProviderModels(providerId, apiKey, probeOptions).catch(
      () => [],
    );
    const discovered = liveModels.length > 0;
    const models = discovered ? liveModels : catalogModels;
    const preferredModels =
      probeOptions.probeModels ??
      catalog.providers.find((entry) => entry.provider === providerId)?.probe_models ??
      [];
    const preferred =
      providerId === 'nvidia'
        ? preferredModels.map((id) => id.replace(/^nvidia\//i, ''))
        : preferredModels;
    const candidates = probeOptions.modelRef
      ? [probeOptions.modelRef.slice(String(providerId).length + 1)]
      : [...new Set([...orderProbeCandidates(models, preferred), ...preferred])];
    if (!candidates.length) throw new Error(`No chat-capable models available for ${providerId}`);
    let openRouterSnapshot: ParsedQuotaWindow[] = [];
    if (providerId === 'openrouter') {
      const configured = (probeOptions.baseUrl ?? 'https://openrouter.ai').replace(/\/$/, '');
      const origin = configured.endsWith('/api/v1') ? configured.slice(0, -7) : configured;
      const response = await (probeOptions.fetch ?? globalThis.fetch)(`${origin}/api/v1/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        ...(probeOptions.signal ? { signal: probeOptions.signal } : {}),
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
    let usedModel: string | null = null;
    let lastModelError: unknown;
    for (const modelId of candidates.slice(0, 5)) {
      const observedFetch = createObservedFetch(
        (observation) => observations.push(observation),
        { providerId, model: modelId },
        probeOptions.fetch ?? globalThis.fetch,
      );
      try {
        const languageModel = createLanguageModel(`${providerId}/${modelId}` as ModelRef, {
          apiKey,
          ...(probeOptions.baseUrl ? { baseUrl: probeOptions.baseUrl } : {}),
          fetch: observedFetch,
          ...(probeOptions.sessionId ? { sessionId: probeOptions.sessionId } : {}),
        });
        await generateText({
          model: languageModel,
          prompt: 'Reply with one character.',
          maxOutputTokens: 64,
          maxRetries: 0,
          ...(probeOptions.signal ? { abortSignal: probeOptions.signal } : {}),
        });
        usedModel = modelId;
        break;
      } catch (error) {
        lastModelError = error;
        if (!isUnavailableModelError(error)) throw error;
        const reason = errorMessage(error);
        skippedModels.push({ model: modelId, reason: reason.replaceAll(apiKey, '[REDACTED]') });
        if (discovered)
          liveModels.splice(
            liveModels.findIndex((model) => model.ref.endsWith(`/${modelId}`)),
            1,
          );
      }
    }
    if (!usedModel && lastModelError instanceof Error) throw lastModelError;
    if (!usedModel && lastModelError) throw new Error(errorMessage(lastModelError));
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
    return {
      ok: true,
      keyValid: true,
      latencyMs: Math.max(0, performance.now() - started),
      message: 'Key valid',
      windows,
      models: (discovered
        ? liveModels
        : usedModel
          ? models.filter((model) => model.ref.endsWith(`/${usedModel}`))
          : []
      )
        .filter(
          (model) =>
            !skippedModels.some(
              (skipped) => skipped.model === model.ref.slice(String(providerId).length + 1),
            ),
        )
        .map((model) => model.ref.slice(String(providerId).length + 1)),
      errorKind: null,
      usedModel,
      skippedModels,
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
      message: redactSecrets(mapped.message, [key, apiKey]),
      windows: quotaWindows(failedObservations),
      models: [],
      errorKind: mapped.kind,
      ...(skippedModels.length ? { skippedModels } : {}),
    };
  }
}

export async function probe(
  providerId: ProviderId | string,
  key: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const controller = new AbortController();
  const requestedTimeoutMs = options.timeoutMs ?? 20_000;
  const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(1, requestedTimeoutMs) : 20_000;
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Provider request timed out', 'TimeoutError'));
      resolve({
        ok: false,
        keyValid: true,
        latencyMs: timeoutMs,
        message: 'Provider request timed out',
        windows: [],
        models: [],
        errorKind: 'timeout',
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([probeWithSignal(providerId, key, { ...options, signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isChatModelId(id: string): boolean {
  return !/(?:embed|embedding|whisper|guard|tts|text-to-speech|image|vision|translate|reward|safety|rerank|moderation|audio|transcri|ocr)/i.test(
    id,
  );
}

function isUnavailableModelError(error: unknown): boolean {
  const message = errorMessage(error);
  const status =
    error && typeof error === 'object'
      ? Number(
          (error as Record<string, unknown>).statusCode ??
            (error as Record<string, unknown>).status ??
            0,
        )
      : 0;
  return (
    status === 404 ||
    status === 410 ||
    /model_not_found|not found for account|end of life|no longer available|model.*not found/i.test(
      message,
    )
  );
}

function errorMessage(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  return providerErrorMessage(record, error);
}

function orderProbeCandidates(models: ModelInfo[], preferred: string[]): string[] {
  const ids = models.map((model) => model.ref.slice(model.providerId.length + 1));
  const orderedPreferred = preferred.filter((id) => ids.includes(id));
  const free = models
    .filter((model) => model.free)
    .map((model) => model.ref.slice(model.providerId.length + 1));
  return [...new Set([...orderedPreferred, ...free, ...ids])];
}

export async function discoverProviderModels(
  providerId: string,
  key: string,
  options: Pick<ProbeOptions, 'baseUrl' | 'fetch' | 'signal'> = {},
): Promise<ReturnType<typeof ModelInfoSchema.parse>[]> {
  let baseURL: string | undefined;
  if (providerId === 'openai') baseURL = options.baseUrl ?? 'https://api.openai.com/v1';
  else if (providerId === 'openrouter') baseURL = options.baseUrl ?? 'https://openrouter.ai/api/v1';
  else if (compatibleDefaults[providerId])
    baseURL = options.baseUrl ?? compatibleDefaults[providerId];
  else if (options.baseUrl) baseURL = options.baseUrl;
  if (!baseURL) return [];
  const response = await (options.fetch ?? globalThis.fetch)(
    `${baseURL.replace(/\/$/, '')}/models`,
    {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!response.ok) throw new Error(`Model discovery failed with HTTP ${String(response.status)}`);
  const payload: unknown = await response.json().catch(() => ({}));
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const catalog = await providerCatalog();
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== 'string') return [];
    const rawId = id.replace(/^models\//, '');
    const normalizedId = providerId === 'nvidia' ? rawId.replace(/^nvidia\//i, '') : rawId;
    if (!isChatModelId(normalizedId)) return [];
    const known = catalog.models.find(
      (model) => model.providerId === providerId && model.ref.endsWith(`/${normalizedId}`),
    );
    const supportedParameters = (item as Record<string, unknown>).supported_parameters;
    const metadataSupportsTools =
      Array.isArray(supportedParameters) && supportedParameters.includes('tools');
    const verifiedToolModel =
      metadataSupportsTools ||
      known?.toolCalling === true ||
      isPreferredToolModel(providerId, normalizedId);
    const excludedByName =
      /(?:preview|experimental|image|tts|audio|transcribe|embedding|guard|omni|nano-banana|antigravity)/i.test(
        normalizedId,
      );
    const free =
      (providerId === 'openrouter' && /:free(?:$|:)/i.test(normalizedId)) || (known?.free ?? false);
    const contextWindow = known?.contextWindow ?? 8192;
    const model = ModelInfoSchema.safeParse({
      ref: `${providerId}/${normalizedId}`,
      providerId,
      name:
        (item as Record<string, unknown>).name &&
        typeof (item as Record<string, unknown>).name === 'string'
          ? (item as Record<string, unknown>).name
          : (known?.name ?? normalizedId),
      tier: known?.tier ?? 'T2',
      contextWindow,
      maxOutput: known?.maxOutput ?? 4096,
      toolCalling:
        verifiedToolModel &&
        (!excludedByName || metadataSupportsTools || known?.toolCalling === true),
      reasoning: known?.reasoning ?? false,
      free,
      priceInPerM: free ? 0 : (known?.priceInPerM ?? null),
      priceOutPerM: free ? 0 : (known?.priceOutPerM ?? null),
    });
    return model.success ? [model.data] : [];
  });
}

function isPreferredToolModel(providerId: string, modelId: string): boolean {
  if (providerId === 'gemini') return /^(?:gemini-3\.8-flash|gemini-flash-latest)$/i.test(modelId);
  if (providerId === 'groq') return /^(?:qwen\/qwen3\.8-27b|openai\/gpt-oss-120b)$/i.test(modelId);
  if (providerId === 'mistral') return /^(?:codestral-|devstral-|mistral-medium)/i.test(modelId);
  if (providerId === 'cerebras') return /^(?:gpt-oss-120b|qwen-3\.8-27b)$/i.test(modelId);
  if (providerId === 'sambanova')
    return /^(?:gpt-oss-120b|meta-llama-3\.3-70b-instruct)$/i.test(modelId);
  if (providerId === 'nvidia') return /^(?:nvidia\/)?nemotron-3-super-/i.test(modelId);
  return false;
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
