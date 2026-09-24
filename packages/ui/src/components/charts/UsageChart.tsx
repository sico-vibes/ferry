import { useMemo } from 'react';
import type { UsageHistoryPoint } from '@ferry/shared';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatQuotaValue } from '../providers/QuotaWindowBar';

export type UsageMetric = 'requests' | 'tokens' | 'cost';
const series = Array.from({ length: 8 }, (_, index) => `var(--series-${String(index + 1)})`);
function metricValue(point: UsageHistoryPoint, metric: UsageMetric): number {
  if (metric === 'requests') return point.requests;
  if (metric === 'tokens') return point.inputTokens + point.outputTokens;
  return point.costUsd;
}
function shortDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(`${date}T00:00:00`),
  );
}
function TooltipContent({
  active,
  payload,
  label,
  metric,
  names,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number }[];
  label?: string;
  metric: UsageMetric;
  names: Map<string, string>;
}) {
  if (!active || !payload?.length) return null;
  const unit = metric === 'requests' ? 'requests' : metric === 'tokens' ? 'tokens' : 'USD';
  return (
    <div className="min-w-36 rounded-card border border-border-soft bg-panel p-2.5 shadow-[var(--highlight-top)]">
      <p className="mb-1.5 text-meta font-medium text-text-2">{label}</p>
      {payload.map((item) => (
        <p className="flex items-center justify-between gap-4 text-meta" key={item.name}>
          <span className="text-text-2">{names.get(item.name ?? '') ?? item.name}</span>
          <b className="font-medium tabular-nums text-text-1">
            {metric === 'cost'
              ? `$${(item.value ?? 0).toFixed(2)}`
              : `${formatQuotaValue(item.value ?? 0, metric === 'tokens' ? 'tokens' : 'requests')} ${unit}`}
          </b>
        </p>
      ))}
    </div>
  );
}

export function UsageChart({
  data,
  providerNames,
  metric = 'requests',
}: {
  data: UsageHistoryPoint[];
  providerNames: Record<string, string>;
  metric?: UsageMetric;
}) {
  const { rows, providers } = useMemo(() => {
    const dates = [...new Set(data.map((point) => point.date))].sort();
    const providerIds = [...new Set(data.map((point) => point.providerId))];
    const rows = dates.map((date) => {
      const row: Record<string, string | number> = { date: shortDate(date) };
      for (const point of data.filter((entry) => entry.date === date))
        row[point.providerId] = metricValue(point, metric);
      return row;
    });
    return { rows, providers: providerIds };
  }, [data, metric]);
  const names = new Map(providers.map((id) => [id, providerNames[id] ?? id]));
  return (
    <div
      className="h-44 min-h-44 w-full"
      role="img"
      aria-label={`14 day stacked ${metric} usage by provider`}
    >
      <ResponsiveContainer height="100%" width="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border-hair)" vertical={false} />
          <XAxis
            axisLine={false}
            tickLine={false}
            dataKey="date"
            tick={{ fill: 'var(--text-3)', fontSize: 11 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            width={44}
            tick={{ fill: 'var(--text-3)', fontSize: 11 }}
            tickFormatter={(value: number) =>
              formatQuotaValue(
                value,
                metric === 'cost' ? 'usd' : metric === 'tokens' ? 'tokens' : 'requests',
              )
            }
          />
          <Tooltip content={<TooltipContent metric={metric} names={names} />} />
          {providers.map((id, index) => (
            <Bar
              dataKey={id}
              fill={series[index % series.length]}
              key={id}
              name={id}
              stackId="usage"
              radius={[2, 2, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
