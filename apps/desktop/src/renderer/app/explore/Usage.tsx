import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RingGauge, ResetsTimeline, ShowMoreList, UsageChart } from '@ferry/ui';
import { useFerryClient } from '../../data/client';

const number = (value: number) => new Intl.NumberFormat().format(value);

export function UsageTab() {
  const client = useFerryClient();
  const realQuota = window.ferryHybrid?.getRealDomains().includes('quota') ?? false;
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: capacity } = useQuery({
    queryKey: ['usage', 'capacity'],
    queryFn: () => client.quota.capacity(),
  });
  const { data: history = [] } = useQuery({
    queryKey: ['usage', 'history', 14],
    queryFn: () => client.quota.history(14),
  });
  const providerNames = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  );
  const timeline = useMemo(() => {
    if (!capacity) return undefined;
    const futureResets = capacity.nextResets.filter(
      (reset) => new Date(reset.at).getTime() > Date.now(),
    );
    if (futureResets.length > 0) return { ...capacity, nextResets: futureResets };
    const nextResets = providers
      .filter(
        (provider) =>
          provider.enabled &&
          (provider.keyStatus === 'valid' || provider.keyStatus === 'not_applicable'),
      )
      .flatMap((provider) =>
        provider.windows.flatMap((window) =>
          window.resetAt && new Date(window.resetAt).getTime() > Date.now()
            ? [
                {
                  providerId: provider.id,
                  windowId: window.id,
                  label: `${provider.name} · ${window.periodLabel}`,
                  at: window.resetAt,
                },
              ]
            : [],
        ),
      );
    return { ...capacity, nextResets };
  }, [capacity, providers]);
  const usableProviderIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.enabled &&
          (provider.keyStatus === 'valid' || provider.keyStatus === 'not_applicable'),
      )
      .map((provider) => provider.id),
  );
  const maxSteps = Math.max(1, ...(capacity?.perProvider ?? []).map((item) => item.stepsLeft ?? 0));

  return (
    <div aria-label="Usage dashboard" className="grid gap-8" role="region">
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label="Capacity remaining" className="grid gap-4 rounded-card bg-card p-5">
          <div className="flex items-center gap-5">
            {capacity ? (
              <RingGauge
                label={`${String(capacity.percentRemaining)}% capacity remaining`}
                size={104}
                stroke={7}
                value={capacity.percentRemaining}
              />
            ) : (
              <span
                aria-label="Capacity unavailable"
                className="text-2xl text-muted-foreground"
                role="img"
              >
                --
              </span>
            )}
            <div>
              <h2 className="text-ui-section font-semibold">Today</h2>
              <p className="mt-1 text-ui-secondary text-muted-foreground">Capacity remaining</p>
              <p className="mt-2 text-ui-title font-semibold tabular-nums">
                {capacity ? `${number(capacity.stepsLeftToday)} steps left` : 'Usage unavailable'}
              </p>
            </div>
          </div>
          <ShowMoreList
            items={(capacity?.perProvider ?? []).filter((item) =>
              usableProviderIds.has(item.providerId),
            )}
            groupKey="models:usage:capacity"
            label="providers"
            listClassName="grid gap-3"
            renderItem={(item) => (
              <li className="grid gap-1.5" key={item.providerId}>
                <div className="flex justify-between gap-3 text-ui-meta">
                  <span className="truncate text-muted-foreground">
                    {providerNames[item.providerId] ?? item.providerId}
                  </span>
                  {item.stepsLeft === null ? (
                    <span
                      aria-label={`${providerNames[item.providerId] ?? item.providerId}: limit unknown`}
                      className="text-muted-foreground"
                      role="img"
                    >
                      Limit unknown
                    </span>
                  ) : (
                    <span className="tabular-nums">{number(item.stepsLeft)}</span>
                  )}
                </div>
                {item.stepsLeft !== null && (
                  <div
                    aria-label={`${providerNames[item.providerId] ?? item.providerId} capacity`}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={(item.stepsLeft / maxSteps) * 100}
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                  >
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${String((item.stepsLeft / maxSteps) * 100)}%` }}
                    />
                  </div>
                )}
              </li>
            )}
          />
        </section>
        {timeline ? (
          <ResetsTimeline providerNames={providerNames} summary={timeline} />
        ) : (
          <section aria-label="Reset timeline" className="min-h-40 rounded-card bg-card p-5">
            <p className="text-ui-secondary text-muted-foreground">
              Reset times are not available yet.
            </p>
          </section>
        )}
      </div>

      <section aria-label="Usage history" className="grid gap-4 rounded-card bg-card p-5">
        <header className="flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <h2 className="text-ui-section font-semibold">Last 14 days</h2>
            <p className="mt-1 text-ui-secondary text-muted-foreground">
              Daily token use by provider
            </p>
          </div>
          {!realQuota && (
            <span className="rounded-full bg-muted px-2.5 py-1 text-ui-meta text-muted-foreground">
              Demo data
            </span>
          )}
        </header>
        <UsageChart data={history} metric="tokens" providerNames={providerNames} />
        <ShowMoreList
          ariaLabel="Providers in chart"
          items={[...new Set(history.map((item) => item.providerId))]}
          groupKey="models:usage:chart-providers"
          label="providers"
          listClassName="flex flex-wrap gap-x-4 gap-y-2"
          renderItem={(id, index) => (
            <li className="flex items-center gap-2 text-ui-meta text-muted-foreground" key={id}>
              <span
                className="size-2 rounded-sm"
                style={{ backgroundColor: `var(--series-${String((index % 8) + 1)})` }}
              />
              {providerNames[id] ?? id}
            </li>
          )}
        />
      </section>
    </div>
  );
}
