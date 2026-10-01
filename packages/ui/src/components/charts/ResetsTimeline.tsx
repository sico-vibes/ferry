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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () =>
      document.visibilityState === 'visible' &&
      document.documentElement.dataset.windowBackgrounded !== 'true';
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const tick = () => {
      timer = undefined;
      if (!active()) return;
      setNow(Date.now());
      timer = globalThis.setTimeout(tick, 60_000);
    };
    const resume = () => {
      stop();
      if (active()) timer = globalThis.setTimeout(tick, 60_000);
    };
    const background = (event: Event) => {
      document.documentElement.dataset.windowBackgrounded = String(
        (event as CustomEvent<boolean>).detail,
      );
      resume();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('ferry:window-background', background);
    resume();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('ferry:window-background', background);
    };
  }, []);
  const end = now + 86_400_000;
  const resets = [
    ...new Map(
      summary.nextResets.map((reset) => [`${reset.providerId}:${reset.windowId}`, reset]),
    ).values(),
  ]
    .filter((reset) => new Date(reset.at).getTime() > now && new Date(reset.at).getTime() < end)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const markers: { position: number; resets: typeof resets }[] = [];
  for (const reset of resets) {
    const position = Math.max(
      3.5,
      Math.min(100, ((new Date(reset.at).getTime() - now) / 86_400_000) * 100),
    );
    const cluster = markers.find((marker) => Math.abs(marker.position - position) < 2.5);
    if (cluster) cluster.resets.push(reset);
    else markers.push({ position, resets: [reset] });
  }
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
          aria-hidden="true"
          className="absolute top-2.5 h-6 w-px bg-blue-500"
          style={{
            left: '0%',
          }}
        />
        {markers.map((marker) => {
          const names = marker.resets.map(
            (reset) => providerNames[reset.providerId] ?? reset.providerId,
          );
          const label = marker.resets
            .map((reset) => {
              const providerName = providerNames[reset.providerId] ?? reset.providerId;
              return `${providerName} · ${relativeLabel(reset.at, now)} · ${timeLabel(reset.at)}`;
            })
            .join('; ');
          return (
            <button
              aria-label={`${String(marker.resets.length)} reset${marker.resets.length === 1 ? '' : 's'} near ${names.join(', ')}: ${label}`}
              className="absolute top-1 inline-flex h-5 min-w-5 -translate-x-1/2 items-center justify-center rounded-pill border-2 border-blue-500 bg-canvas px-1 text-meta font-semibold tabular-nums text-text-1 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              key={marker.resets.map((reset) => `${reset.providerId}:${reset.windowId}`).join('|')}
              style={{
                left: `${String(marker.position)}%`,
              }}
              title={label}
              type="button"
            >
              {marker.resets.length > 1 ? marker.resets.length : null}
            </button>
          );
        })}
        <span className="absolute inset-x-0 top-7 flex justify-between text-[11px] leading-4 text-text-3">
          <span>Now</span>
          <span>+24h</span>
        </span>
      </div>
      <ul className="mt-2 grid gap-1.5">
        {resets.slice(0, 4).map((reset) => (
          <li
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-meta"
            key={`${reset.providerId}:${reset.windowId}`}
          >
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
