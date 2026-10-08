import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SkeletonRows, SkeletonChart, SkeletonStat, ProviderLogo, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { activityLevel, summarizeUsage } from './usageSummary';
import { formatTokens } from './modelFacts';

const count = new Intl.NumberFormat('en');

/** Usage at a glance under the Home composer (reference 06): activity, this month, top providers. */
export function HomeStats() {
  const client = useFerryClient();
  const { data: history } = useQuery({
    queryKey: ['quota-history', 30],
    queryFn: () => client.quota.history(30),
    staleTime: 60_000,
  });
  const { data: providers = [], isPending: providersPending } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const stats = useMemo(() => (history ? summarizeUsage(history) : null), [history]);
  if (!stats || providersPending)
    return (
      <section aria-label="Usage summary" className="v2-home-stats">
        <div className="v2-home-stat">
          <header>Activity</header>
          <SkeletonChart />
        </div>
        <div className="v2-home-stat">
          <header>Usage</header>
          <SkeletonStat />
          <SkeletonRows rows={2} />
        </div>
        <div className="v2-home-stat">
          <header>Top providers</header>
          <SkeletonRows rows={3} />
        </div>
      </section>
    );
  const busiest = Math.max(...stats.daily.map((day) => day.requests));
  if (busiest === 0)
    return (
      <p className="v2-home-stats-empty">
        Your activity, monthly totals and top providers will show here after your first chat.
      </p>
    );
  const providerName = (id: string) => providers.find((item) => item.id === id)?.name ?? id;
  return (
    <UiV2.TooltipProvider delayDuration={0}>
      <section aria-label="Usage summary" className="v2-home-stats">
        <div className="v2-home-stat">
          <header>
            <span>Activity</span>
            <span>Past 30 days</span>
          </header>
          <div className="v2-activity-grid" role="img" aria-label="Requests per day, past 30 days">
            {stats.daily.map((day) => (
              <UiV2.Tooltip key={day.date}>
                <UiV2.TooltipTrigger asChild>
                  <span data-level={activityLevel(day.requests, busiest)} />
                </UiV2.TooltipTrigger>
                <UiV2.TooltipContent side="top">
                  {new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en', {
                    month: 'short',
                    day: 'numeric',
                  })}
                  {' · '}
                  {count.format(day.requests)} requests
                </UiV2.TooltipContent>
              </UiV2.Tooltip>
            ))}
          </div>
        </div>
        <div className="v2-home-stat">
          <header>
            <span>Usage</span>
            <span>This month</span>
          </header>
          <dl className="v2-home-stat-rows">
            <div>
              <dt>Requests</dt>
              <dd>{count.format(stats.monthRequests)}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{formatTokens(stats.monthTokens)}</dd>
            </div>
            <div>
              <dt>{stats.monthSpendUsd > 0 ? 'Paid spend' : 'Served free'}</dt>
              <dd>
                {stats.monthSpendUsd > 0
                  ? `$${stats.monthSpendUsd.toFixed(2)}`
                  : `${String(Math.round((stats.freeShare ?? 1) * 100))}%`}
              </dd>
            </div>
          </dl>
        </div>
        <div className="v2-home-stat">
          <header>
            <span>Top providers</span>
            <span>Past 30 days</span>
          </header>
          <ol className="v2-home-stat-rows">
            {stats.topProviders.map((item, index) => (
              <li key={item.providerId}>
                <span className="v2-home-rank">{index + 1}</span>
                <ProviderLogo
                  name={providerName(item.providerId)}
                  providerId={item.providerId}
                  size={14}
                />
                <span className="v2-home-provider">{providerName(item.providerId)}</span>
                <span className="v2-home-count">{count.format(item.requests)}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </UiV2.TooltipProvider>
  );
}
