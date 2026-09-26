import { z } from 'zod';

/**
 * Typed provider failure classification and short, reset-aware resilience state.
 * The 429 quota/rate distinction is adapted from OmniRoute's MIT-licensed
 * `src/shared/utils/classify429.ts` (https://github.com/diegosouzapw/OmniRoute).
 */
export type ErrorFamily =
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth'
  | 'model_not_found'
  | 'tools_unsupported'
  | 'context_overflow'
  | 'content_filter'
  | 'unsupported_free_tier'
  | 'server'
  | 'timeout'
  | 'request_scoped_client'
  | 'stream_failure';

export interface ClassifiedProviderError {
  family: ErrorFamily;
  status: number | null;
  retryAfterMs: number | null;
  message: string;
  scope: 'model' | 'key' | 'provider' | 'none';
}

export interface ProviderErrorInput {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
  responseBody?: unknown;
  headers?: Headers | Record<string, string | undefined>;
  retryAfter?: unknown;
  now?: number;
}

export function parseRetryAfter(value: unknown, now = Date.now()): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const relative =
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i.exec(
      text,
    );
  if (relative?.slice(1).some(Boolean))
    return Math.round(
      Number(relative[1] ?? 0) * 3_600_000 +
        Number(relative[2] ?? 0) * 60_000 +
        Number(relative[3] ?? 0) * 1000 +
        Number(relative[4] ?? 0),
    );
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function header(headers: ProviderErrorInput['headers'], key: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(key) ?? undefined;
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return found?.[1];
}

function bodyDetails(value: unknown): { text: string; retryMs: number | null } {
  if (typeof value !== 'string') return { text: '', retryMs: null };
  try {
    const root: unknown = JSON.parse(value);
    if (!root || typeof root !== 'object') return { text: value, retryMs: null };
    const record = root as Record<string, unknown>;
    const error =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : record;
    const texts = [record.message, error.message, error.status, error.code, error.type]
      .filter(
        (item): item is string | number => typeof item === 'string' || typeof item === 'number',
      )
      .map(String);
    let retryMs: number | null = null;
    const details = Array.isArray(error.details)
      ? error.details
      : Array.isArray(record.details)
        ? record.details
        : [];
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue;
      const item = detail as Record<string, unknown>;
      if (typeof item.retryDelay === 'string') retryMs = parseRetryAfter(item.retryDelay);
    }
    const joined = texts.join(' ');
    if (retryMs === null) {
      const phrase =
        /(?:retry|reset|try again|available again)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(
          joined,
        );
      if (phrase?.[1] && phrase[2])
        retryMs = parseRetryAfter(`${phrase[1]}${unitSuffix(phrase[2])}`);
    }
    return { text: joined, retryMs };
  } catch {
    return { text: value, retryMs: null };
  }
}

function unitSuffix(unit: string): string {
  if (/^(?:milliseconds?|ms)$/i.test(unit)) return 'ms';
  if (/^(?:minutes?|mins?|m)$/i.test(unit)) return 'm';
  if (/^(?:hours?|hrs?|h)$/i.test(unit)) return 'h';
  return 's';
}

const quotaWords =
  /quota|billing|credit balance|insufficient credits|daily limit|monthly limit|resource exhausted|超出配额|配额已用完|使用量已达|クォータ|利用上限|할당량 초과|사용량 한도/i;
const terminalQuota =
  /billing hard limit|no credits|credit balance is zero|insufficient balance|payment required/i;
const capability =
  /tool.{0,30}(?:not supported|unsupported|not enabled)|function calling.{0,30}(?:not supported|not enabled)|tool_choice.{0,30}(?:invalid|unsupported)/i;

export function classifyProviderError(input: ProviderErrorInput): ClassifiedProviderError {
  const status = Number(input.statusCode ?? input.status ?? 0) || null;
  const body = bodyDetails(input.responseBody);
  const message = [input.message, input.code, input.type, body.text]
    .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
    .map(String)
    .join(' ')
    .slice(0, 500);
  const retryAfterMs =
    parseRetryAfter(input.retryAfter ?? header(input.headers, 'retry-after'), input.now) ??
    body.retryMs;
  const lower = message.toLowerCase();
  let family: ErrorFamily;
  if (
    status === 404 ||
    status === 410 ||
    /model_not_found|model.{0,25}(?:not found|no longer available|retired|end of life)/i.test(
      message,
    )
  )
    family = 'model_not_found';
  else if (status === 400 && capability.test(message)) family = 'tools_unsupported';
  else if (
    status === 400 &&
    /context length|maximum context|too many tokens|input is too long/i.test(message)
  )
    family = 'context_overflow';
  else if (/content_filter|safety.{0,20}blocked|content policy/i.test(message))
    family = 'content_filter';
  else if (status === 401 || /unauthorized|invalid api key|authentication failed/i.test(message))
    family = 'auth';
  else if (
    status === 403 &&
    /free (?:models|tier).{0,60}(?:open.?code|zen)|only work inside open.?code/i.test(message)
  )
    family = 'unsupported_free_tier';
  else if (status === 402 || status === 403) family = 'quota_exhausted';
  else if (status === 429 || /resource_exhausted|rate.?limit|too many requests/i.test(message)) {
    const shortDeclaredWindow = retryAfterMs !== null && retryAfterMs < 3_600_000;
    family =
      terminalQuota.test(message) || (!shortDeclaredWindow && quotaWords.test(message))
        ? 'quota_exhausted'
        : 'rate_limit';
  } else if (status === 400 || (status !== null && status >= 400 && status < 500))
    family = 'request_scoped_client';
  else if (status === 408 || status === 504 || /timeout|timed out|aborterror/i.test(message))
    family = 'timeout';
  else if (status !== null && status >= 500) family = 'server';
  else family = status === null ? 'stream_failure' : 'server';
  const scope =
    family === 'quota_exhausted'
      ? 'key'
      : family === 'model_not_found' ||
          family === 'tools_unsupported' ||
          family === 'context_overflow'
        ? 'model'
        : family === 'server' || family === 'timeout' || family === 'stream_failure'
          ? 'provider'
          : family === 'rate_limit'
            ? 'key'
            : 'none';
  return {
    family,
    status,
    retryAfterMs,
    message: message || lower || 'Provider request failed',
    scope,
  };
}

export type ResilienceScope = 'model' | 'key' | 'provider';
export interface ResilienceEntry {
  scope: ResilienceScope;
  key: string;
  failures: number;
  expiresAt: string;
  lastFamily: ErrorFamily;
  strikes: number;
  strikeWindowEndsAt: string;
}
export const ResilienceEntrySchema = z.object({
  scope: z.enum(['model', 'key', 'provider']),
  key: z.string(),
  failures: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
  lastFamily: z.enum([
    'rate_limit',
    'quota_exhausted',
    'auth',
    'model_not_found',
    'tools_unsupported',
    'context_overflow',
    'content_filter',
    'unsupported_free_tier',
    'server',
    'timeout',
    'request_scoped_client',
    'stream_failure',
  ]),
  strikes: z.number().int().nonnegative(),
  strikeWindowEndsAt: z.iso.datetime(),
});

/** Serializable scope ledger. Three strikes in ten minutes impose a capped ten-minute ban. */
export class ResilienceLedger {
  private readonly entries = new Map<string, ResilienceEntry>();
  constructor(snapshot: readonly ResilienceEntry[] = []) {
    for (const entry of snapshot) this.entries.set(`${entry.scope}:${entry.key}`, { ...entry });
  }
  snapshot(): ResilienceEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
  active(scope: ResilienceScope, key: string, now = Date.now()): ResilienceEntry | undefined {
    const id = `${scope}:${key}`;
    const entry = this.entries.get(id);
    if (entry && Date.parse(entry.expiresAt) <= now) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }
  availableModelRefs(refs: readonly string[], now = Date.now()): string[] {
    return refs.filter((ref) => this.active('model', ref, now) === undefined);
  }
  recordFailure(
    error: ClassifiedProviderError,
    modelRef: string,
    providerId: string,
    now = Date.now(),
  ): void {
    if (error.scope === 'none') return;
    const scope = error.scope;
    const key = scope === 'model' ? modelRef : scope === 'key' ? providerId : providerId;
    const id = `${scope}:${key}`;
    const previous = this.active(scope, key, now);
    const withinStrikeWindow = previous && Date.parse(previous.strikeWindowEndsAt) > now;
    const strikes = withinStrikeWindow ? previous.strikes + 1 : 1;
    const failures = (previous?.failures ?? 0) + 1;
    const hinted = error.retryAfterMs;
    const backoff = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(failures - 1, 8));
    const proposedDuration = hinted ?? backoff;
    const duration =
      strikes >= 3
        ? 10 * 60_000
        : scope === 'model'
          ? Math.min(30 * 60_000, Math.max(60_000, proposedDuration))
          : proposedDuration;
    this.entries.set(id, {
      scope,
      key,
      failures,
      expiresAt: new Date(now + duration).toISOString(),
      lastFamily: error.family,
      strikes,
      strikeWindowEndsAt: new Date(
        withinStrikeWindow ? Date.parse(previous.strikeWindowEndsAt) : now + 10 * 60_000,
      ).toISOString(),
    });
  }
  recordSuccess(scope: ResilienceScope, key: string): void {
    const id = `${scope}:${key}`;
    const previous = this.entries.get(id);
    if (!previous) return;
    const failures = Math.floor(previous.failures / 2);
    if (!failures) this.entries.delete(id);
    else this.entries.set(id, { ...previous, failures, expiresAt: new Date(0).toISOString() });
  }
  earliest(now = Date.now()): ResilienceEntry | undefined {
    return this.snapshot()
      .filter((entry) => Date.parse(entry.expiresAt) > now)
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0];
  }
}

export function reorderByCapabilities<T extends { toolCalling?: boolean }>(
  models: readonly T[],
  requiresTools: boolean,
): T[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort(
      (a, b) =>
        Number(Boolean(b.model.toolCalling) && requiresTools) -
          Number(Boolean(a.model.toolCalling) && requiresTools) || a.index - b.index,
    )
    .map(({ model }) => model);
}
