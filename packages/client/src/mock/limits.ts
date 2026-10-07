import type { Provider, ProviderLimits } from '@ferry/shared';
export function providerLimitsFromProviders(providers: readonly Provider[]): ProviderLimits[] {
  return providers.map((provider): ProviderLimits => {
    const windows = provider.windows.flatMap((window): ProviderLimits['windows'] => {
      const period =
        window.kind === 'fixed_daily' ? 'day' : window.kind === 'monthly' ? 'month' : undefined;
      return period
        ? [
            {
              metric: window.metric,
              period,
              limit: window.limit,
              used: window.used,
              remaining: window.remaining,
              resetAt: window.resetAt,
              source:
                window.confidence === 'exact'
                  ? 'header'
                  : window.confidence === 'learned'
                    ? 'learned'
                    : 'published',
              observedAt: window.observedAt ?? null,
              ...(window.scope === 'model' && window.modelRef ? { model: window.modelRef } : {}),
            },
          ]
        : [];
    });
    return {
      providerId: provider.id,
      providerName: provider.name,
      state: windows.some((window) => window.limit !== null || window.remaining !== null)
        ? 'known'
        : provider.billingEnabled || provider.tag === 'paid'
          ? 'paid_no_limit'
          : 'no_published_limit',
      windows,
    };
  });
}
