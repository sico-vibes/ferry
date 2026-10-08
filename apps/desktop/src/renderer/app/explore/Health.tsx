import { FailuresSection, PausedProviders } from './Failures';
import { useQuery } from '@tanstack/react-query';
import type { ProviderHealthSnapshot } from '@ferry/shared';
import { ShowMoreList } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { keys } from '../../data/queries';

const stateLabels: Record<ProviderHealthSnapshot['state'], string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
};
const stateColors: Record<ProviderHealthSnapshot['state'], string> = {
  healthy: 'var(--success)',
  degraded: 'var(--warning)',
  down: 'var(--danger)',
};

function relative(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const span =
    minutes < 1
      ? 'under a minute'
      : minutes < 60
        ? `${String(minutes)}m`
        : `${String(Math.round(minutes / 60))}h`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

/** Provider health: circuit breaker, key cooldowns, locked models and latency, live. */
export function HealthTab() {
  const client = useFerryClient();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: health = [], isLoading } = useQuery({
    queryKey: keys.health,
    queryFn: () => client.providers.health(),
  });
  const usable = new Map(
    providers
      .filter(
        (provider) =>
          provider.enabled &&
          (provider.keyStatus === 'valid' || provider.keyStatus === 'not_applicable'),
      )
      .map((provider) => [provider.id, provider.name]),
  );
  const rows = health
    .filter((item) => usable.has(item.providerId))
    .sort((a, b) => {
      const rank = { down: 0, degraded: 1, healthy: 2 } as const;
      return rank[a.state] - rank[b.state];
    });
  const counts = { healthy: 0, degraded: 0, down: 0 };
  for (const row of rows) counts[row.state] += 1;

  return (
    <div aria-label="Provider health" className="grid gap-6" role="region">
      <PausedProviders providers={providers} />
      <FailuresSection providers={providers} />
      <section className="grid gap-4 rounded-card bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-ui-section font-semibold">Provider health</h2>
            <p className="mt-1 text-ui-secondary text-muted-foreground">
              Temporary cooldowns recover in the background. Providers paused after failed requests
              stay paused until you resume them.
            </p>
          </div>
          <div className="flex gap-4 text-ui-meta tabular-nums text-muted-foreground">
            {(['healthy', 'degraded', 'down'] as const).map((state) => (
              <span className="inline-flex items-center gap-1.5" key={state}>
                <span
                  aria-hidden="true"
                  className="inline-block size-2 rounded-full"
                  style={{ background: stateColors[state] }}
                />
                {String(counts[state])} {stateLabels[state].toLowerCase()}
              </span>
            ))}
          </div>
        </div>
        {isLoading ? (
          <p className="text-ui-secondary text-muted-foreground">Checking providers…</p>
        ) : rows.length === 0 ? (
          <p className="text-ui-secondary text-muted-foreground">
            No connected providers yet. Add a key on the Providers tab.
          </p>
        ) : (
          <ShowMoreList
            items={rows}
            groupKey="models:health"
            label="providers"
            listClassName="grid divide-y divide-border"
            renderItem={(row) => (
              <li className="grid gap-2 py-3 first:pt-0" key={row.providerId}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {usable.get(row.providerId) ?? row.providerId}
                  </span>
                  <span
                    className="inline-flex items-center gap-1.5 text-ui-meta"
                    style={{ color: stateColors[row.state] }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 rounded-full"
                      style={{ background: stateColors[row.state] }}
                    />
                    {stateLabels[row.state]}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-ui-meta tabular-nums text-muted-foreground">
                  <span>
                    Latency{' '}
                    {row.latencyP50Ms === null
                      ? '—'
                      : `${String(Math.round(row.latencyP50Ms))} ms typical · ${String(Math.round(row.latencyP95Ms ?? row.latencyP50Ms))} ms slow`}
                  </span>
                  <span>
                    Success{' '}
                    {row.successRate1h === null
                      ? '—'
                      : `${String(Math.round(row.successRate1h * 100))}% last hour`}
                  </span>
                  {row.breaker !== 'closed' && (
                    <span>
                      {row.breaker === 'open' ? 'Paused' : 'Retrying'}
                      {relative(row.nextProbeAt)
                        ? ` · next check ${relative(row.nextProbeAt) ?? ''}`
                        : ''}
                    </span>
                  )}
                </div>
                {row.lastError && row.state !== 'healthy' && (
                  <p className="truncate text-ui-meta text-muted-foreground" title={row.lastError}>
                    Last error: {row.lastError}
                  </p>
                )}
                {row.keys.some((key) => key.cooldownUntil) && (
                  <p className="text-ui-meta text-muted-foreground">
                    {row.keys
                      .filter((key) => key.cooldownUntil)
                      .map(
                        (key) =>
                          `Key ${key.keyId.slice(-6)} rate-limited, back ${relative(key.cooldownUntil) ?? 'soon'}`,
                      )
                      .join(' · ')}
                  </p>
                )}
                {row.lockedModels.length > 0 && (
                  <p className="text-ui-meta text-muted-foreground">
                    Paused models:{' '}
                    {row.lockedModels.map((model) => `${model.ref} (${model.reason})`).join(', ')}
                  </p>
                )}
              </li>
            )}
          />
        )}
      </section>
    </div>
  );
}
