import { useEffect, useState } from 'react';
import type { QuotaWindow } from '@ferry/shared';
import { ConfidenceDot } from './ConfidenceDot';

function formatCompact(value: number, metric: QuotaWindow['metric']): string {
  if (metric === 'usd') return `$${value.toFixed(2)}`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return String(value);
}

function countdown(resetAt: string | null, now: number): string | null {
  if (!resetAt) return null;
  const minutes = Math.max(0, Math.ceil((new Date(resetAt).getTime() - now) / 60_000));
  if (minutes >= 1440)
    return `${String(Math.floor(minutes / 1440))}d ${String(Math.floor((minutes % 1440) / 60))}h`;
  if (minutes >= 60) return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  return `${String(minutes)}m`;
}

export function QuotaWindowBar({ window }: { window: QuotaWindow }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.resetAt
      ? globalThis.setInterval(() => {
          setNow(Date.now());
        }, 60_000)
      : undefined;
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [window.resetAt]);
  const percent =
    window.limit === null || window.limit === 0
      ? null
      : Math.min(100, (window.used / window.limit) * 100);
  const color =
    percent === 100
      ? 'var(--danger)'
      : percent !== null && percent >= 80
        ? 'var(--warn)'
        : 'var(--blue-500)';
  const reset = countdown(window.resetAt, now);
  return (
    <div className="grid gap-1.5" aria-label={`${window.metric} ${window.periodLabel}`}>
      <div className="flex items-center justify-between gap-3 text-meta">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-text-2">
          <ConfidenceDot confidence={window.confidence} />
          <span className="truncate">
            {window.metric === 'usd' ? 'Cost' : window.metric === 'tokens' ? 'Tokens' : 'Requests'}{' '}
            · {window.periodLabel}
          </span>
        </span>
        <span className="shrink-0 font-medium tabular-nums text-text-1">
          {window.limit === null
            ? `${formatCompact(window.used, window.metric)} · no cap`
            : `${formatCompact(window.used, window.metric)} / ${formatCompact(window.limit, window.metric)}`}
        </span>
      </div>
      <div
        aria-label={window.limit === null ? 'No cap' : `${String(Math.round(percent ?? 0))}% used`}
        className="h-1.5 overflow-hidden rounded-pill bg-raised"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className={
            window.limit === null
              ? 'block h-full w-2/5 animate-pulse rounded-pill bg-blue-500/60'
              : 'block h-full rounded-pill transition-[width] duration-300'
          }
          style={
            window.limit === null
              ? undefined
              : { width: `${String(percent)}%`, backgroundColor: color }
          }
        />
      </div>
      {reset && <span className="text-[10px] leading-3 text-text-3">Resets in {reset}</span>}
    </div>
  );
}

export { formatCompact as formatQuotaValue };
