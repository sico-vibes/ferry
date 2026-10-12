import { CheckCircle2, CircleDot, Clock3, MinusCircle, XCircle } from 'lucide-react';
import type { ProviderCheckProgress } from '@ferry/shared';
import { ProviderLogo, UiV2 } from '@ferry/ui';

export function ProviderCheckResults({ progress }: { progress: ProviderCheckProgress }) {
  const entries =
    progress.entries ??
    progress.results.map((result) => ({
      providerId: result.providerId,
      name: result.providerId,
      modelRef: result.modelRef,
      state: 'complete' as const,
      reason: undefined,
    }));
  if (!entries.length) return null;
  const eligible = entries.filter((entry) => entry.state !== 'skipped');
  const finished = eligible.filter((entry) =>
    ['complete', 'cancelled'].includes(entry.state),
  ).length;
  return (
    <section className="provider-check-console" aria-label="Connection check progress">
      <header role="status" aria-live="polite">
        <strong>
          {progress.running
            ? 'Checking connections'
            : progress.cancelled
              ? 'Checks cancelled'
              : 'Connection results'}
        </strong>
        <span className="muted tabular-nums">
          {finished} of {eligible.length} checked
        </span>
      </header>
      <UiV2.Progress
        value={eligible.length ? (finished / eligible.length) * 100 : 0}
        aria-label="Provider check completion"
      />
      <ul>
        {entries.map((entry) => {
          const result = progress.results.find((row) => row.providerId === entry.providerId);
          const state =
            entry.state === 'complete' ? (result?.ok ? 'reachable' : 'error') : entry.state;
          const label = {
            reachable: 'Reachable',
            error: 'Needs attention',
            queued: 'Queued',
            checking: 'Checking',
            skipped: 'Skipped',
            cancelled: 'Cancelled',
          }[state];
          const Icon =
            state === 'reachable'
              ? CheckCircle2
              : state === 'error'
                ? XCircle
                : state === 'checking'
                  ? CircleDot
                  : state === 'queued'
                    ? Clock3
                    : MinusCircle;
          return (
            <li key={entry.providerId} data-check-state={state}>
              <ProviderLogo providerId={entry.providerId} name={entry.name} size={20} />
              <div className="min-w-0">
                <strong>{entry.name}</strong>
                <p className="muted text-ui-meta break-words">{entry.reason ?? entry.modelRef}</p>
                {result && (
                  <details>
                    <summary>Check details</summary>
                    <p className="muted text-ui-meta">
                      {result.message} {result.features}
                    </p>
                    <p className="muted text-ui-meta">
                      {result.sampleCount} sample. Authentication:{' '}
                      {result.authentication ?? 'unknown'}. Checked{' '}
                      {new Date(result.at).toLocaleString()}.
                    </p>
                  </details>
                )}
              </div>
              <div className="provider-check-outcome">
                <span className="provider-check-state">
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </span>
                {result?.firstResponseMs !== null && result?.firstResponseMs !== undefined && (
                  <span className="muted text-ui-meta tabular-nums">
                    {result.firstResponseMs} ms first response
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
