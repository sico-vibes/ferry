import type { UsageHistoryPoint } from '@ferry/shared';

export interface HomeStats {
  /** Requests per day for the last `days` days, oldest first. */
  daily: { date: string; requests: number }[];
  monthRequests: number;
  monthTokens: number;
  monthSpendUsd: number;
  /** Share of this month's requests served at no cost. */
  freeShare: number | null;
  topProviders: { providerId: string; requests: number }[];
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function summarizeUsage(
  history: UsageHistoryPoint[],
  now = new Date(),
  days = 30,
): HomeStats {
  const byDay = new Map<string, number>();
  for (const point of history) byDay.set(point.date, (byDay.get(point.date) ?? 0) + point.requests);
  const daily = Array.from({ length: days }, (_, index) => {
    const date = isoDay(new Date(now.getTime() - (days - 1 - index) * 86_400_000));
    return { date, requests: byDay.get(date) ?? 0 };
  });
  const month = isoDay(now).slice(0, 7);
  const thisMonth = history.filter((point) => point.date.startsWith(month));
  const monthRequests = thisMonth.reduce((sum, point) => sum + point.requests, 0);
  const freeRequests = thisMonth
    .filter((point) => point.costUsd === 0)
    .reduce((sum, point) => sum + point.requests, 0);
  const byProvider = new Map<string, number>();
  const since = daily[0]?.date ?? '';
  for (const point of history)
    if (point.date >= since)
      byProvider.set(point.providerId, (byProvider.get(point.providerId) ?? 0) + point.requests);
  return {
    daily,
    monthRequests,
    monthTokens: thisMonth.reduce((sum, point) => sum + point.inputTokens + point.outputTokens, 0),
    monthSpendUsd: thisMonth.reduce((sum, point) => sum + point.costUsd, 0),
    freeShare: monthRequests > 0 ? freeRequests / monthRequests : null,
    topProviders: [...byProvider.entries()]
      .filter(([, requests]) => requests > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([providerId, requests]) => ({ providerId, requests })),
  };
}

/** 0 (none) to 4 (busiest) intensity buckets relative to the busiest day. */
export function activityLevel(requests: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (requests <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((requests / max) * 4))) as 1 | 2 | 3 | 4;
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 5
    ? 'Good evening'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';
}
