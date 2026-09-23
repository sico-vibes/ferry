import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import {
  CountUp,
  Pill,
  ResetsTimeline,
  RingGauge,
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
    <section aria-label="Usage dashboard" className="canvas min-h-0 overflow-y-auto p-5">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <nav aria-label="Explore sections" className="flex gap-1 border-b border-border-hair pb-3">
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
        <header className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h1 className="text-[20px] font-semibold leading-7 text-text-1">Usage</h1>
            <p className="mt-1 text-body text-text-2">
              Quota, handoffs and spend across connected providers
            </p>
          </div>
          <span className="rounded-pill border border-border-hair bg-card px-2.5 py-1 text-meta text-text-3">
            Demo data
          </span>
        </header>
        <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(280px,.85fr)] gap-3 max-[1200px]:grid-cols-1">
          <section
            aria-label="Capacity remaining"
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-4 rounded-card border border-border-hair bg-card p-4"
          >
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
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {(capacity?.perProvider ?? [])
                  .filter((item) => item.stepsLeft !== null)
                  .map((item) => (
                    <li className="min-w-0" key={item.providerId}>
                      <div className="mb-1 flex justify-between gap-2 text-meta">
                        <span className="truncate text-text-2">
                          {names[item.providerId] ?? item.providerId}
                        </span>
                        <span className="tabular-nums text-text-1">
                          {item.stepsLeft === null ? '—' : format(item.stepsLeft)}
                        </span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-pill bg-white/[0.07]">
                        <span
                          className="block h-full rounded-pill bg-blue-500"
                          style={{ width: `${String(((item.stepsLeft ?? 0) / maxSteps) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          </section>
          {timelineSummary && <ResetsTimeline providerNames={names} summary={timelineSummary} />}
        </div>
        <section
          aria-label="Usage history"
          className="rounded-card border border-border-hair bg-card p-4"
        >
          <header className="mb-3 flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <h2 className="text-label font-semibold text-text-1">Provider usage</h2>
              <p className="mt-1 text-meta text-text-3">Daily totals over the last 14 days</p>
            </div>
            <div aria-label="Usage metric" className="flex gap-1">
              {(['requests', 'tokens', 'cost'] as const).map((item) => (
                <button
                  aria-pressed={metric === item}
                  className={`rounded-pill px-2.5 py-1.5 text-meta capitalize ${metric === item ? 'bg-blue-tint text-link' : 'text-text-3 hover:text-text-2'}`}
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
        </section>
        <div className="grid grid-cols-3 gap-3 max-[1150px]:grid-cols-1">
          <section
            aria-label="Handoffs in fourteen days"
            className="rounded-card border border-border-hair bg-card p-3.5"
          >
            <header className="mb-3 flex items-baseline justify-between">
              <h2 className="text-label font-semibold text-text-1">Handoffs (14d)</h2>
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
                  <span className="h-1.5 overflow-hidden rounded-pill bg-white/[0.07]">
                    <span
                      className="block h-full rounded-pill bg-blue-500"
                      style={{ width: `${String((item.count / maxHandoffs) * 100)}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-text-1">{item.count}</span>
                </li>
              ))}
            </ul>
          </section>
          <section
            aria-label="Optimizer savings"
            className="rounded-card border border-border-hair bg-card p-3.5"
          >
            <header className="mb-3 flex items-center gap-2">
              <h2 className="mr-auto text-label font-semibold text-text-1">Optimizer savings</h2>
              {optimizer?.demo && (
                <span className="rounded-pill bg-white/[0.06] px-2 py-1 text-[10px] text-text-3">
                  Demo data
                </span>
              )}
            </header>
            <p className="text-[18px] font-semibold tabular-nums text-text-1">
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
          </section>
          <section
            aria-label="Paid spend"
            className="rounded-card border border-border-hair bg-card p-3.5"
          >
            <header className="mb-3 flex items-center">
              <h2 className="mr-auto text-label font-semibold text-text-1">Paid spend</h2>
              <span className="text-meta text-text-3">OpenCode Go</span>
            </header>
            <div className="grid gap-3">
              {providerById
                .get('opencode-go' as Provider['id'])
                ?.windows.map((window) => <QuotaWindowBar key={window.id} window={window} />) ?? (
                <p className="text-meta text-text-3">No paid spend data available.</p>
              )}
            </div>
          </section>
        </div>
        <button
          className="inline-flex w-fit items-center gap-1 self-end text-meta text-link hover:underline"
          onClick={() => void navigate({ to: '/explore' })}
          type="button"
        >
          Manage providers <ArrowUpRight size={13} />
        </button>
      </div>
    </section>
  );
}
