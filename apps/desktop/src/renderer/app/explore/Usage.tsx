import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import {
  CountUp,
  PageHeader,
  Pill,
  ResetsTimeline,
  RingGauge,
  Section,
  Stack,
  UsageChart,
  QuotaWindowBar,
  type UsageMetric,
} from '@ferry/ui';
import type { HandoffStat, Provider } from '@ferry/shared';
import { useFerryClient } from '../../data/client';

const reasons: Record<HandoffStat['reason'], string> = {
  quota: 'Quota exhausted',
  rate_limit: 'Rate limited',
  error: 'Provider error',
  context: 'Context limit',
  capability: 'Capability',
  manual: 'Manual',
};
const format = (value: number) => new Intl.NumberFormat().format(value);

export function UsageCanvas() {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const realQuota = window.ferryHybrid?.getRealDomains().includes('quota') ?? false;
  const realOptimizer = window.ferryHybrid?.getRealDomains().includes('optimizer') ?? false;
  const [metric, setMetric] = useState<UsageMetric>('requests');
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
  const { data: handoffs = [] } = useQuery({
    queryKey: ['usage', 'handoffs', 14],
    queryFn: () => client.quota.handoffs(14),
  });
  const { data: optimizer } = useQuery({
    queryKey: ['usage', 'optimizer'],
    queryFn: () => client.optimizer.stats(),
  });
  const names = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  );
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const timelineSummary = useMemo(() => {
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
  const maxHandoffs = Math.max(1, ...handoffs.map((handoff) => handoff.count));
  const maxSteps = Math.max(1, ...(capacity?.perProvider ?? []).map((item) => item.stepsLeft ?? 0));

  useEffect(() => {
    const off = client.on('quota.updated', (summary) => {
      cache.setQueryData(['usage', 'capacity'], summary);
      void cache.invalidateQueries({ queryKey: ['usage'] });
    });
    return off;
  }, [cache, client]);

  return (
    <section aria-label="Usage dashboard" className="canvas page-scroll-canvas min-h-0 p-5">
      <Stack className="page-content mx-auto w-full max-w-[1200px]" gap={4}>
        <PageHeader
          title="Usage"
          subtitle="Quota, handoffs and spend across connected providers"
          nav={
            <nav aria-label="Explore sections" className="flex gap-1">
              <Pill onClick={() => void navigate({ to: '/explore' })} size="sm" variant="outline">
                Providers
              </Pill>
              <Pill
                className="border-border-strong bg-raised"
                onClick={() => void navigate({ to: '/explore/usage' })}
                size="sm"
                variant="outline"
              >
                Usage
              </Pill>
            </nav>
          }
          actions={
            !realQuota && (
              <span className="rounded-pill border border-border-hair bg-card px-3 py-1 text-meta text-text-3">
                Demo data
              </span>
            )
          }
        />
        <div className="usage-top-grid grid">
          <Section title="Capacity remaining" ariaLabel="Capacity remaining">
            <div className="usage-capacity-grid min-h-24">
              <RingGauge
                label={`${String(capacity?.percentRemaining ?? 0)}% capacity remaining`}
                size={96}
                stroke={6}
                value={capacity?.percentRemaining ?? 0}
              />
              <div className="min-w-0">
                <p className="text-label text-text-2">Available today</p>
                <p className="mt-1 text-title font-semibold tabular-nums text-text-1">
                  ≈ <CountUp to={capacity?.stepsLeftToday ?? 0} /> steps left
                </p>
                <ul className="usage-provider-grid mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                  {(capacity?.perProvider ?? []).map((item) => (
                    <li className="min-w-0" key={item.providerId}>
                      <div className="usage-provider-row mb-1 flex justify-between gap-2 text-meta">
                        <span className="usage-provider-name min-w-[88px] truncate text-text-2">
                          {names[item.providerId] ?? item.providerId}
                        </span>
                        {item.stepsLeft === null ? (
                          <span
                            aria-label={`${names[item.providerId] ?? item.providerId} has no daily cap`}
                            className="text-label text-text-1"
                            role="img"
                            title="No daily cap"
                          >
                            ∞
                          </span>
                        ) : (
                          <span className="tabular-nums text-text-1">{format(item.stepsLeft)}</span>
                        )}
                      </div>
                      {item.stepsLeft !== null && (
                        <div className="h-1 overflow-hidden rounded-pill bg-raised">
                          <span
                            className="block h-full rounded-pill bg-blue-500"
                            style={{ width: `${String((item.stepsLeft / maxSteps) * 100)}%` }}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Section>
          <Section ariaLabel="Reset timeline" className="min-h-[168px]">
            {timelineSummary ? (
              <ResetsTimeline providerNames={names} summary={timelineSummary} />
            ) : (
              <div aria-hidden="true" className="min-h-[168px]" />
            )}
          </Section>
        </div>
        <Section title="Provider usage" ariaLabel="Usage history">
          <header className="mb-3 flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <p className="mt-1 text-meta text-text-3">Daily totals over the last 14 days</p>
            </div>
            <div aria-label="Usage metric" className="flex gap-1">
              {(['requests', 'tokens', 'cost'] as const).map((item) => (
                <button
                  aria-pressed={metric === item}
                  className={`rounded-pill px-3 py-1 text-meta capitalize ${metric === item ? 'bg-blue-tint text-link' : 'text-text-3 hover:text-text-2'}`}
                  key={item}
                  onClick={() => {
                    setMetric(item);
                  }}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </header>
          <UsageChart data={history} metric={metric} providerNames={names} />
          <ul aria-label="Providers in chart" className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {[...new Set(history.map((item) => item.providerId))].map((id, index) => (
              <li className="flex items-center gap-1.5 text-meta text-text-3" key={id}>
                <span
                  className="size-2 rounded-sm"
                  style={{ backgroundColor: `var(--series-${String((index % 8) + 1)})` }}
                />
                {names[id] ?? id}
              </li>
            ))}
          </ul>
        </Section>
        <div className="usage-summary-grid grid">
          <Section title="Handoffs (14d)" ariaLabel="Handoffs in fourteen days">
            <header className="mb-3 flex items-baseline justify-between">
              <span className="text-meta text-text-3">
                {format(handoffs.reduce((sum, item) => sum + item.count, 0))} total
              </span>
            </header>
            <ul className="grid gap-2">
              {handoffs.map((item) => (
                <li
                  className="grid grid-cols-[92px_minmax(0,1fr)_24px] items-center gap-2 text-meta"
                  key={item.reason}
                >
                  <span className="truncate text-text-2">{reasons[item.reason]}</span>
                  <span className="h-1.5 overflow-hidden rounded-pill bg-raised">
                    <span
                      className="block h-full rounded-pill bg-blue-500"
                      style={{ width: `${String((item.count / maxHandoffs) * 100)}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-text-1">{item.count}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Optimizer savings" ariaLabel="Optimizer savings">
            <header className="mb-3 flex items-center gap-2">
              <span className="mr-auto" />
              {!realOptimizer && optimizer?.demo && (
                <span className="rounded-pill bg-raised px-2 py-1 text-[10px] leading-[14px] text-text-2">
                  Demo data
                </span>
              )}
            </header>
            <p className="text-[18px] leading-6 font-semibold tabular-nums text-text-1">
              {format(optimizer?.today.savedTokens ?? 0)}{' '}
              <span className="text-label font-medium text-text-2">tokens today</span>
            </p>
            <p className="mt-1 text-meta text-text-3">
              {optimizer?.today.percent ?? 0}% saved across optimized output
            </p>
            <ul className="mt-3 grid gap-2">
              {(optimizer?.byOptimizer ?? []).map((item) => (
                <li className="flex items-center justify-between gap-3 text-meta" key={item.id}>
                  <span className="truncate text-text-2">{item.name}</span>
                  <span className="shrink-0 tabular-nums text-text-1">
                    {format(item.savedTokens)} · {item.percent}%
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Paid spend" ariaLabel="Paid spend">
            <header className="mb-3 flex items-center">
              <span className="mr-auto" />
              <span className="text-meta text-text-3">OpenCode Go</span>
            </header>
            <div className="grid gap-3">
              {providerById
                .get('opencode-go' as Provider['id'])
                ?.windows.map((window) => <QuotaWindowBar key={window.id} window={window} />) ?? (
                <p className="text-meta text-text-3">No paid spend data available.</p>
              )}
            </div>
          </Section>
        </div>
        <button
          className="inline-flex w-fit items-center gap-1 self-end text-meta text-link hover:underline"
          onClick={() => void navigate({ to: '/explore' })}
          type="button"
        >
          Manage providers <ArrowUpRight size={13} />
        </button>
      </Stack>
    </section>
  );
}
