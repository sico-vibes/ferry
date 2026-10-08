import { parseRetryAfter } from '@ferry/router';
import type { QuotaWindow } from '@ferry/shared';

export function quotaPeriodMs(window?: QuotaWindow): number | null {
  if (!window) return null;
  if (window.kind !== 'rolling') return window.durationMs ?? 86400_000;
  return window.durationMs ?? null;
}

/** Reset headers may be relative durations, epoch seconds/milliseconds, or dates. */
export function retryDelayFromHeaders(
  headers: Headers | Record<string, string | undefined>,
  now: number,
): number | null {
  const get = (name: string) =>
    headers instanceof Headers
      ? headers.get(name)
      : Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const retry = parseRetryAfter(get('retry-after'), now);
  if (retry !== null) return retry;
  const resets = [
    'x-ratelimit-reset',
    'ratelimit-reset',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'x-ratelimit-reset-rpm',
    'x-ratelimit-reset-tpm',
  ].flatMap((name) => {
    const value = get(name);
    if (!value) return [];
    const dimension = /-(requests|tokens|rpm|tpm)$/.exec(name)?.[1];
    const headroom = dimension ? get(`x-ratelimit-remaining-${dimension}`) : undefined;
    if (headroom !== undefined && headroom !== null && Number(headroom) > 0) return [];
    const numeric = Number(value);
    const delay =
      Number.isFinite(numeric) && numeric > 1_000_000_000
        ? (numeric > 1_000_000_000_000 ? numeric : numeric * 1000) - now
        : (parseRetryAfter(value, now) ?? Date.parse(value) - now);
    return Number.isFinite(delay) && delay > 0 ? [delay] : [];
  });
  return resets.length ? Math.max(...resets) : null;
}
