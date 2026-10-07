import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResetsTimeline, ShowMoreList, UsageChart } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { usesRealDomain } from '../../data/realDomains';
import { useLimits } from '../../data/queries';
import { describeReset, describeSource, describeWindow, remainingShare } from '../../data/limits';

const number = (value: number) => new Intl.NumberFormat().format(value);

export function UsageTab() {
  const client = useFerryClient();
  const realQuota = usesRealDomain('quota');
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: capacity } = useQuery({
    queryKey: ['usage', 'capacity'],
    queryFn: () => client.quota.capacity(),
  });
  const { data: limits = [] } = useLimits();
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
  const cachedTokens = history.reduce((sum, item) => sum + (item.cachedTokens ?? 0), 0);

  return (
    <div aria-label="Usage dashboard" className="grid gap-8" role="region">
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label="Provider limits" className="grid gap-4 rounded-card bg-card p-5">
          <div>
            <h2 className="text-ui-section font-semibold">Limits</h2>
            <p className="mt-1 text-ui-secondary text-muted-foreground">
              Daily and monthly limits your providers report or publish. Ferry doesn’t guess the
              rest.
            </p>
          </div>
          <ShowMoreList
            items={limits.filter((item) => usableProviderIds.has(item.providerId))}
            groupKey="models:usage:limits"
            label="providers"
            listClassName="grid gap-4"
            renderItem={(provider) => (
              <li className="grid gap-2" key={provider.providerId}>
                <div className="flex justify-between gap-3 text-ui-label">
                  <span className="truncate font-medium">{provider.providerName}</span>
                  {provider.state !== 'known' && (
                    <span className="text-ui-meta text-muted-foreground">
                      {provider.state === 'paid_no_limit'
                        ? 'Pay as you go · no daily limit'
                        : 'No published limit'}
                    </span>
                  )}
                </div>
                {provider.windows.map((window, index) => {
                  const share = remainingShare(window);
                  const reset = describeReset(window);
                  return (
                    <div
                      className="grid gap-1"
                      key={`${window.metric}-${window.period}-${window.model ?? ''}-${String(index)}`}
                    >
                      <div className="flex justify-between gap-3 text-ui-meta">
                        <span className="truncate text-muted-foreground">
                          {window.model ? `${window.model} · ` : ''}
                          {describeWindow(window)}
                        </span>
                        {reset ? (
                          <span className="shrink-0 text-muted-foreground">{reset}</span>
                        ) : null}
                      </div>
                      {share !== null && (
                        <div
                          aria-label={`${provider.providerName}: ${describeWindow(window)}`}
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={Math.round(share * 100)}
                          className="h-1.5 overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                          title={`Source: ${describeSource(window)}`}
                        >
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${String(share * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
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
        <p className="text-ui-meta text-muted-foreground">
          Cached input tokens: <span className="tabular-nums">{number(cachedTokens)}</span>
        </p>
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
