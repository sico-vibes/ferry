import { CapacitySummarySchema } from '@ferry/shared';
import type { CapacitySummary, ModelInfo, Provider } from '@ferry/shared';

export type CapacityProvider = Provider & { dailyStepBudget?: number };

export function computeCapacity(
  providers: readonly CapacityProvider[],
  now: Date,
  models?: readonly ModelInfo[],
): CapacitySummary {
  const eligible = providers.filter(
    (provider) =>
      provider.enabled && provider.keyStatus === 'valid' && provider.dailyStepBudget !== undefined,
  );
  const stepsLeftToday = eligible.reduce(
    (sum, provider) => sum + (provider.stepsLeftToday ?? 0),
    0,
  );
  const budget = eligible.reduce((sum, provider) => sum + (provider.dailyStepBudget ?? 0), 0);
  const percentRemaining = budget === 0 ? 0 : Math.round((stepsLeftToday / budget) * 100);
  const perProvider = providers.map((provider) => {
    const day = provider.windows.find((window) => window.kind === 'fixed_daily');
    return {
      providerId: provider.id,
      stepsLeft: eligible.includes(provider) ? provider.stepsLeftToday : null,
      percent: day?.limit
        ? Math.max(0, Math.min(100, Math.round(((day.limit - day.used) / day.limit) * 100)))
        : null,
      nextResetAt: day?.resetAt ?? null,
    };
  });
  const lowProviders = eligible.filter((provider) => {
    const window = provider.windows.find((candidate) => candidate.kind === 'fixed_daily');
    return (
      window?.limit !== null &&
      window?.limit !== undefined &&
      window.limit > 0 &&
      (window.limit - window.used) / window.limit < 0.2
    );
  });
  const mainCoderIds = new Set(
    models === undefined
      ? ['gemini']
      : models.filter((model) => model.tier !== 'T3').map((model) => model.providerId),
  );
  const lowMainCoders = lowProviders
    .filter((provider) => mainCoderIds.has(provider.id))
    .map((provider) => ({
      provider,
      resetAt: provider.windows.find((window) => window.kind === 'fixed_daily')?.resetAt ?? null,
    }))
    .filter(
      (entry): entry is { provider: CapacityProvider; resetAt: string } => entry.resetAt !== null,
    )
    .sort((a, b) => a.resetAt.localeCompare(b.resetAt));
  const lowCapacity = lowProviders.length > 0;
  const bannerProvider = lowMainCoders[0]?.provider;
  const resetAt = lowMainCoders[0]?.resetAt ?? null;
  const remaining = resetAt ? Math.max(0, new Date(resetAt).getTime() - now.getTime()) : 0;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const nextResets = providers
    .filter(
      (provider) =>
        provider.enabled &&
        (provider.keyStatus === 'valid' || provider.keyStatus === 'not_applicable'),
    )
    .flatMap((provider) =>
      provider.windows
        .filter((window) => window.resetAt !== null)
        .map((window) => ({
          providerId: provider.id,
          windowId: window.id,
          label: `${provider.name.split(' ')[0] ?? provider.name} \u00b7 ${window.periodLabel}`,
          at: window.resetAt ?? now.toISOString(),
        })),
    )
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, 4);
  return CapacitySummarySchema.parse({
    stepsLeftToday,
    percentRemaining,
    lowCapacity,
    perProvider,
    nextResets,
    banner:
      lowCapacity && bannerProvider && resetAt
        ? {
            text: `Free capacity low \u2014 ${bannerProvider.name.split(' ')[0] ?? bannerProvider.name} resets in ${String(hours)}h ${String(minutes)}m`,
            actionLabel: 'Add provider',
            action: 'add_provider',
          }
        : null,
    updatedAt: now.toISOString(),
  });
}
