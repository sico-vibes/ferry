import type { ProviderLimits } from '@ferry/shared';

export type LimitWindow = ProviderLimits['windows'][number];

const metricLabels: Record<LimitWindow['metric'], string> = {
  requests: 'requests',
  tokens: 'tokens',
  usd: 'USD',
  credits: 'credits',
};
const sourceLabels: Record<LimitWindow['source'], string> = {
  header: 'reported by the provider',
  endpoint: 'reported by the provider',
  published: 'published limit',
  learned: 'learned from a rate-limit reply',
};

const count = (value: number) => new Intl.NumberFormat().format(Math.max(0, Math.round(value)));

/** Share of the window still available, or null when Ferry doesn't know both numbers. */
export function remainingShare(window: LimitWindow): number | null {
  if (window.limit === null || window.limit <= 0 || window.remaining === null) return null;
  return Math.min(1, Math.max(0, window.remaining / window.limit));
}

/** "38 of 50 requests left today" */
export function describeWindow(window: LimitWindow): string {
  const period = window.period === 'day' ? 'today' : 'this month';
  const unit = metricLabels[window.metric];
  if (window.remaining !== null && window.limit !== null)
    return `${count(window.remaining)} of ${count(window.limit)} ${unit} left ${period}`;
  if (window.remaining !== null) return `${count(window.remaining)} ${unit} left ${period}`;
  if (window.limit !== null)
    return `${count(window.used)} of ${count(window.limit)} ${unit} used ${period}`;
  return `${count(window.used)} ${unit} used ${period}`;
}

export function describeSource(window: LimitWindow): string {
  return sourceLabels[window.source];
}

/** "resets in 3h 20m", or null when unknown or past. */
export function describeReset(window: LimitWindow, now = Date.now()): string | null {
  if (!window.resetAt) return null;
  const ms = Date.parse(window.resetAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `resets in ${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `resets in ${String(hours)}h ${String(minutes % 60)}m`;
  return `resets in ${String(Math.round(hours / 24))}d`;
}

/**
 * What the Usage page shows for one provider: its own windows and any per-model window you've
 * used, while untouched per-model windows with the same limit collapse into one summary line
 * (OpenRouter publishes the same daily limit for every free model).
 */
export function summarizeProviderWindows(provider: ProviderLimits): {
  rows: LimitWindow[];
  untouched: { count: number; text: string }[];
} {
  const rows: LimitWindow[] = [];
  const groups = new Map<string, { count: number; window: LimitWindow }>();
  for (const window of provider.windows) {
    if (!window.model || window.used > 0) {
      rows.push(window);
      continue;
    }
    const key = `${window.metric}:${window.period}:${String(window.limit)}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { count: 1, window });
  }
  const untouched = [...groups.values()].map(({ count, window }) => {
    const unit = metricLabels[window.metric];
    const period = window.period === 'day' ? 'a day' : 'a month';
    const limit =
      window.limit === null ? 'No published limit' : `${String(window.limit)} ${unit} ${period}`;
    return {
      count,
      text:
        count === 1
          ? `${window.model ?? ''} · ${limit}`
          : `${limit} each for ${String(count)} other models`,
    };
  });
  return { rows, untouched };
}

/**
 * The daily window closest to running out, for the sidebar. Only windows you've used today count:
 * an untouched free plan at 100% says nothing about your day.
 */
export function tightestDailyWindow(
  limits: readonly ProviderLimits[],
): { providerName: string; window: LimitWindow; share: number } | null {
  let best: { providerName: string; window: LimitWindow; share: number } | null = null;
  for (const provider of limits)
    for (const window of provider.windows) {
      if (window.period !== 'day' || window.used <= 0) continue;
      const share = remainingShare(window);
      if (share === null) continue;
      if (!best || share < best.share)
        best = { providerName: provider.providerName, window, share };
    }
  return best;
}
