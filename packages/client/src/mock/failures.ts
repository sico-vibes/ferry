import { ProviderFailuresSchema, type FailureOptions, type ProviderFailures } from '@ferry/shared';
import type { MockState } from './types.js';

export function mockFailures(
  state: MockState,
  now: Date,
  providerId?: string,
  options: FailureOptions = {},
): ProviderFailures {
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const recent = new Date(now.getTime() - (options.sinceHours ?? 168) * 3_600_000).toISOString();
  const distinct = (rows: MockState['requestFailures']) =>
    new Set(rows.map((row) => row.requestId)).size;
  const counts = (rows: MockState['requestFailures']) => ({
    failed24h: distinct(rows.filter((row) => row.at >= day)),
    failed7d: distinct(rows.filter((row) => row.at >= week)),
    byKind: Object.fromEntries(
      [...new Set(rows.map((row) => row.kind))].map((kind) => [
        kind,
        distinct(rows.filter((row) => row.kind === kind && row.at >= week)),
      ]),
    ),
    lastError: rows[0]?.message ?? null,
    lastFailureAt: rows[0]?.at ?? null,
    lastSuccessAt: null,
  });
  const rows = state.requestFailures.slice().sort((a, b) => b.at.localeCompare(a.at));
  return ProviderFailuresSchema.parse({
    providers: state.providers
      .filter((provider) => !providerId || provider.id === providerId)
      .map((provider) => {
        const failures = rows.filter((row) => row.providerId === provider.id);
        const counted = failures.filter((row) => row.counted === 1 && row.at >= day);
        const reset = state.failureResets[provider.id];
        return {
          providerId: provider.id,
          ...counts(failures),
          counted24h: distinct(counted),
          consecutive: distinct(counted.filter((row) => !reset?.includes(row.id))),
          paused: provider.pausedReason ?? null,
          models: [...new Set(failures.map((row) => row.modelRef))].map((modelRef) => {
            const models = failures.filter((row) => row.modelRef === modelRef);
            return {
              modelRef,
              ...counts(models),
              failing: distinct(models.filter((row) => row.counted === 1 && row.at >= day)) >= 3,
            };
          }),
        };
      }),
    recent: rows
      .filter((row) => (!providerId || row.providerId === providerId) && row.at >= recent)
      .slice(0, options.limit ?? 20),
  });
}
