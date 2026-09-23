import { CapacitySummarySchema } from '@ferry/shared';
import type { CapacitySummary, Provider } from '@ferry/shared';

export type CapacityProvider = Provider & { dailyStepBudget?: number };

export function computeCapacity(
  providers: readonly CapacityProvider[],
  now: Date,
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
      percent: day?.limit ? Math.round(((day.limit - day.used) / day.limit) * 100) : null,
      nextResetAt: day?.resetAt ?? null,
    };
  });
  const lowCapacity = eligible.some((provider) => {
    const window = provider.windows.find((candidate) => candidate.kind === 'fixed_daily');
    return (
      window?.limit !== null &&
      window?.limit !== undefined &&
      window.limit > 0 &&
      (window.limit - window.used) / window.limit < 0.2
    );
  });
  const gemini = providers.find((provider) => provider.id === 'gemini');
  const resetAt = gemini?.windows.find((window) => window.kind === 'fixed_daily')?.resetAt;
  const remaining = resetAt ? Math.max(0, new Date(resetAt).getTime() - now.getTime()) : 0;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const nextResets = providers
    .flatMap((provider) =>
      provider.windows
        .filter((window) => window.resetAt !== null)
        .map((window) => ({
          providerId: provider.id,
          windowId: window.id,
          label: `${provider.name.split(' ')[0] ?? provider.name} · ${window.periodLabel}`,
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
    banner: lowCapacity
      ? {
          text: `Free capacity low — Gemini resets in ${String(hours)}h ${String(minutes)}m`,
          actionLabel: 'Add provider',
          action: 'add_provider',
        }
      : null,
    updatedAt: now.toISOString(),
  });
}
