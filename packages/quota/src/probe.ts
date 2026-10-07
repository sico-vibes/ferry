import type { ProviderLimits } from '@ferry/catalog';
import { newId, type ProbeResult, type QuotaObservation, type ProviderId } from '@ferry/shared';
import { catalogWindowId, matchesQuotaModel } from './headers.js';

/** Probe parsers label their periods; retain that scope when binding them to catalog windows. */
export function observationsFromProbe(input: {
  providerId: ProviderId;
  modelRef?: string | undefined;
  windows: ProbeResult['windows'];
  definitions: ProviderLimits['windows'];
  source: QuotaObservation['source'];
  observedAt: string;
}): QuotaObservation[] {
  return input.windows.flatMap((window) => {
    const length = window.id.includes('hour') ? 3600 : window.id.includes('second') ? 1 : 60;
    const rolling =
      window.kind === 'rolling' ||
      (window.kind === 'dynamic' &&
        window.id.startsWith('generic:') &&
        (window.metric === 'requests' || window.metric === 'tokens'));
    const period =
      window.kind === 'fixed_daily' ? 'day' : window.kind === 'monthly' ? 'month' : undefined;
    const definitions = input.definitions.filter(
      (definition) =>
        definition.metric === window.metric &&
        (window.kind === 'fixed_daily'
          ? definition.kind === 'fixed_daily'
          : window.kind === 'monthly'
            ? definition.kind === 'monthly_from_anchor'
            : rolling && definition.kind === 'rolling' && (definition.length ?? 60) === length) &&
        (definition.scope === 'provider' ||
          (!!input.modelRef &&
            !!definition.model &&
            matchesQuotaModel(input.providerId, input.modelRef, definition.model))),
    );
    const targets = definitions.length
      ? definitions.map((definition) => ({
          windowId: catalogWindowId(input.providerId, definition),
          ...(definition.scope === 'model' && input.source !== 'endpoint'
            ? { modelRef: input.modelRef }
            : {}),
        }))
      : [{ windowId: window.id }];
    return targets.map((target) => ({
      id: newId('quota'),
      providerId: input.providerId,
      ...target,
      metric: window.metric,
      ...(period ? { period } : {}),
      ...(window.limit === null || window.remaining === null
        ? {}
        : { value: Math.max(0, window.limit - window.remaining) }),
      limit: window.limit,
      remaining: window.remaining,
      resetAt: window.resetAt,
      source: input.source,
      observedAt: input.observedAt,
    }));
  });
}
