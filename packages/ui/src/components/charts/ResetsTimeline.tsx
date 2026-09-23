import { useEffect, useState } from 'react';
import type { CapacitySummary } from '@ferry/shared';

function relativeLabel(date: string, now: number): string {
  const minutes = Math.max(1, Math.floor((new Date(date).getTime() - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `in ${String(remainingMinutes)}m`;
  return `in ${String(hours)}h ${String(remainingMinutes)}m`;
}

function timeLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
  }).format(new Date(date));
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
  const resets = summary.nextResets
    .filter((reset) => new Date(reset.at).getTime() > now && new Date(reset.at).getTime() < end)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const placedMarkers: { position: number; lane: number }[] = [];
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
          const occupiedLanes = new Set(
            placedMarkers
              .filter((marker) => Math.abs(marker.position - position) < 4.5)
              .map((marker) => marker.lane),
          );
          let lane = 0;
          while (occupiedLanes.has(lane)) lane += 1;
          placedMarkers.push({ position, lane });
          const providerName = providerNames[reset.providerId] ?? reset.providerId;
          const label = `${providerName} · ${relativeLabel(reset.at, now)} · ${timeLabel(reset.at)}`;
          return (
            <button
              aria-label={label}
              className="absolute size-3 -translate-x-1/2 rounded-full border-2 border-blue-500 bg-canvas hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              key={reset.windowId}
              style={{
                left: `${String(position)}%`,
                top: `${String(Math.max(0, 12 - lane * 4))}px`,
              }}
              title={label}
              type="button"
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
              {providerNames[reset.providerId] ?? reset.providerId}
            </span>
            <time className="shrink-0 tabular-nums text-text-1">
              {relativeLabel(reset.at, now)} · {timeLabel(reset.at)}
            </time>
          </li>
        ))}
        {resets.length === 0 && <li className="text-meta text-text-3">No scheduled resets</li>}
      </ul>
    </section>
  );
}
