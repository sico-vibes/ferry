import type { ProviderLimits } from '@ferry/catalog';
import { newId, type QuotaObservation, type RawCallObservation } from '@ferry/shared';

type Window = ProviderLimits['windows'][number];
export function catalogWindowId(providerId: string, window: Window): string {
  const base = `${providerId}:${window.scope}:${window.model ?? '*'}:${window.metric}:${window.kind}`;
  return window.kind === 'rolling' && (window.length ?? 60) !== 60
    ? `${base}:${String(window.length)}`
    : base;
}

/** Catalog patterns match complete refs, provider-local ids, or exact upstream leaf ids. */
export function matchesQuotaModel(providerId: string, modelRef: string, pattern: string): boolean {
  if (!modelRef.startsWith(`${providerId}/`)) return false;
  const bare = modelRef.slice(providerId.length + 1);
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const match = new RegExp(`^${escaped}$`);
  return [modelRef, bare, bare.slice(bare.lastIndexOf('/') + 1)].some((value) => match.test(value));
}

function resetTimestamp(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (/^\d{4}-/.test(value) && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    const at =
      number > 1e12 ? number : number > 1e9 ? number * 1000 : now.getTime() + number * 1000;
    return new Date(at).toISOString();
  }
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (!parts.length || parts.map((part) => part[0]).join('') !== value) return undefined;
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(
    now.getTime() +
      parts.reduce((sum, part) => sum + Number(part[1]) * (scale[part[2] ?? ''] ?? 0), 0),
  ).toISOString();
}

/** One response becomes one paired observation per metric/period, never a minute-to-day copy. */
export function observationsFromRateLimitHeaders(
  call: RawCallObservation,
  windows: readonly Window[],
  now: Date,
): QuotaObservation[] {
  const groups = new Map<
    string,
    {
      metric: 'requests' | 'tokens';
      period: string;
      limit?: number;
      remaining?: number;
      reset?: string | undefined;
    }
  >();
  for (const [rawName, value] of Object.entries(call.rateLimitHeaders)) {
    const name = rawName.toLowerCase();
    const match =
      /^(?:x|anthropic)-ratelimit-(limit|remaining|reset)-(requests|tokens)(?:-(minute|hour|day|month))?$/.exec(
        name,
      ) ??
      /^(?:x|anthropic)-ratelimit-(requests|tokens)-(limit|remaining|reset)(?:-(minute|hour|day|month))?$/.exec(
        name,
      );
    if (!match) continue;
    const fieldFirst = ['limit', 'remaining', 'reset'].includes(match[1] ?? '');
    const field = (fieldFirst ? match[1] : match[2]) as 'limit' | 'remaining' | 'reset';
    const metric = (fieldFirst ? match[2] : match[1]) as 'requests' | 'tokens';
    // Groq's unsuffixed request headers are RPD; unsuffixed tokens are TPM.
    const period =
      match[3] ?? (call.providerId === 'groq' && metric === 'requests' ? 'day' : 'minute');
    const key = `${metric}:${period}`;
    const group = groups.get(key) ?? { metric, period };
    if (field === 'reset') group.reset = resetTimestamp(value, now);
    else if (value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0)
      group[field] = Number(value);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    if (group.limit === undefined && group.remaining === undefined) return [];
    const matching = windows.filter((window) => {
      const period =
        window.kind === 'fixed_daily'
          ? 'day'
          : window.kind === 'monthly_from_anchor'
            ? 'month'
            : window.kind === 'rolling'
              ? { 60: 'minute', 3600: 'hour', 86400: 'day' }[window.length ?? 60]
              : undefined;
      return (
        window.metric === group.metric &&
        period === group.period &&
        (window.scope === 'provider' ||
          (!!window.model && matchesQuotaModel(call.providerId, call.modelRef, window.model)))
      );
    });
    // Prefer a model definition over a provider estimate of the same metric/period.
    const scoped: Window[] = matching.some((window) => window.scope === 'model')
      ? matching.filter((window) => window.scope === 'model')
      : matching;
    if (!scoped.length)
      scoped.push({
        scope: 'provider',
        metric: group.metric,
        kind:
          group.period === 'day'
            ? 'fixed_daily'
            : group.period === 'month'
              ? 'monthly_from_anchor'
              : 'rolling',
        ...(group.period === 'month' ? { day: 1 } : {}),
        ...(group.period === 'hour' ? { length: 3600 } : {}),
        limit: null,
      });
    return scoped.map((window) => ({
      id: newId('quota'),
      providerId: call.providerId,
      windowId: catalogWindowId(call.providerId, window),
      ...(window.scope === 'model' ? { modelRef: call.modelRef } : {}),
      metric: group.metric,
      period: group.period as 'minute' | 'hour' | 'day' | 'month',
      ...(group.limit === undefined ? {} : { limit: group.limit }),
      ...(group.remaining === undefined ? {} : { remaining: group.remaining }),
      ...(group.limit === undefined || group.remaining === undefined
        ? {}
        : { value: Math.max(0, group.limit - group.remaining) }),
      ...(group.reset === undefined ? {} : { resetAt: group.reset }),
      source: 'header' as const,
      observedAt: now.toISOString(),
    }));
  });
}
