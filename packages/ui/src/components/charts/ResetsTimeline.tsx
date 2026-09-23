import { useEffect, useState } from 'react';
import type { CapacitySummary } from '@ferry/shared';

function timeLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(date));
}
export function ResetsTimeline({
  summary,
  providerNames,
}: {
  summary: CapacitySummary;
  providerNames: Record<string, string>;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const end = now + 86_400_000;
  const resets = summary.nextResets.filter(
    (reset) => new Date(reset.at).getTime() > now && new Date(reset.at).getTime() < end,
  );
  return (
    <section
      aria-label="Upcoming quota resets"
      className="rounded-card border border-border-hair bg-card p-3.5"
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-label font-semibold text-text-1">Resets</h2>
        <span className="text-meta text-text-3">Next 24 hours</span>
      </header>
      <div className="relative mx-1 h-12">
        <div className="absolute inset-x-0 top-5 h-px bg-border-soft" />
        <span
          aria-label="Now"
          className="absolute top-2.5 h-6 w-px bg-blue-500"
          style={{
            left: '0%',
          }}
        />
        {resets.map((reset) => {
          const position = Math.max(
            0,
            Math.min(100, ((new Date(reset.at).getTime() - now) / 86_400_000) * 100),
          );
          return (
            <span
              className="absolute top-3.5 size-3 -translate-x-1/2 rounded-full border-2 border-blue-500 bg-canvas"
              key={reset.windowId}
              style={{ left: `${String(position)}%` }}
              title={`${providerNames[reset.providerId] ?? reset.providerId} · ${timeLabel(reset.at)}`}
            />
          );
        })}
        <span className="absolute inset-x-0 top-7 flex justify-between text-[10px] text-text-3">
          <span>Now</span>
          <span>+24h</span>
        </span>
      </div>
      <ul className="mt-2 grid gap-1.5">
        {resets.slice(0, 4).map((reset) => (
          <li className="flex justify-between gap-2 text-meta" key={reset.windowId}>
            <span className="truncate text-text-2">
              {providerNames[reset.providerId] ?? reset.providerId} ·{' '}
              {reset.label.split('·').at(-1)?.trim() ?? reset.label}
            </span>
            <time className="shrink-0 tabular-nums text-text-1">{timeLabel(reset.at)}</time>
          </li>
        ))}
        {resets.length === 0 && <li className="text-meta text-text-3">No scheduled resets</li>}
      </ul>
    </section>
  );
}
