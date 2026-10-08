import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Provider } from '@ferry/shared';
import { Skeleton, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../../data/client';

export function showFailures() {
  const section = document.getElementById('provider-failures');
  section?.querySelectorAll('details').forEach((detail) => {
    detail.open = true;
  });
  section?.scrollIntoView({ block: 'start' });
}

export function PausedProviders({
  providers,
  onViewFailures = showFailures,
}: {
  providers: readonly Provider[];
  onViewFailures?: () => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const act = async (provider: Provider, action: 'resume' | 'probe') => {
    setBusy(provider.id);
    setFeedback('');
    try {
      if (action === 'resume') await client.providers.resume(provider.id);
      else {
        const result = await client.providers.probe(provider.id);
        setFeedback(result.message);
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['providers'] }),
        cache.invalidateQueries({ queryKey: ['provider-failures'] }),
        cache.invalidateQueries({ queryKey: ['providers', 'health'] }),
      ]);
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : 'Could not update this provider. Try again.',
      );
    } finally {
      setBusy(null);
    }
  };
  const paused = providers.filter((provider) => provider.pausedReason);
  if (!paused.length) return null;
  return (
    <section aria-label="Paused providers" className="grid gap-4 rounded-card bg-card p-5">
      {paused.map((provider) => (
        <div className="grid gap-3" key={provider.id}>
          <div className="flex flex-wrap items-center gap-3">
            <UiV2.Badge variant="destructive">Paused</UiV2.Badge>
            <h2 className="text-ui-section font-semibold">
              {provider.name} was paused after {provider.pausedReason?.failedRequests} failed
              requests.
            </h2>
          </div>
          <p className="break-words text-ui-secondary text-muted-foreground">
            Last error: {provider.pausedReason?.lastError}
          </p>
          <div className="flex flex-wrap gap-2">
            <UiV2.Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => void act(provider, 'resume')}
            >
              Resume
            </UiV2.Button>
            <UiV2.Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void act(provider, 'probe')}
            >
              Check key
            </UiV2.Button>
            <UiV2.Button variant="ghost" size="sm" onClick={onViewFailures}>
              View failures
            </UiV2.Button>
            {provider.docsUrl && (
              <a
                className="inline-flex h-8 items-center rounded-button px-3 text-ui-label hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                href={provider.docsUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open provider docs
              </a>
            )}
          </div>
        </div>
      ))}
      {feedback && (
        <p role="status" className="text-ui-secondary text-muted-foreground">
          {feedback}
        </p>
      )}
    </section>
  );
}

export function FailuresSection({ providers }: { providers: readonly Provider[] }) {
  const client = useFerryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['provider-failures'],
    queryFn: () => client.providers.failures(undefined, { limit: 20 }),
    refetchInterval: 30_000,
  });
  const viewedHash = useRef(false);
  useEffect(() => {
    if (data && location.hash === '#failures' && !viewedHash.current) {
      viewedHash.current = true;
      showFailures();
    }
  }, [data]);
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  const rows = data?.providers.filter((provider) => provider.failed7d > 0 || provider.paused) ?? [];
  return (
    <section
      id="provider-failures"
      aria-label="Failures"
      className="grid gap-4 rounded-card bg-card p-5"
    >
      <div>
        <h2 className="text-ui-section font-semibold">Failures</h2>
        <p className="mt-1 text-ui-secondary text-muted-foreground">
          Distinct requests in the last 24 hours and 7 days. Rate limits, quota and local refusals
          never count toward pausing.
        </p>
      </div>
      {isLoading ? (
        <Skeleton rows={2} />
      ) : isError ? (
        <div className="flex items-center gap-3">
          <p>Could not load failures.</p>
          <UiV2.Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </UiV2.Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-ui-secondary text-muted-foreground">No failed requests this week.</p>
      ) : (
        <div className="grid divide-y divide-border">
          {rows.map((provider) => (
            <details className="py-3 first:pt-0" key={provider.providerId}>
              <summary className="cursor-pointer text-ui-label">
                {names.get(provider.providerId) ?? provider.providerId}
                <span className="ml-3 text-ui-meta font-normal tabular-nums text-muted-foreground">
                  {provider.failed24h} in 24 h / {provider.failed7d} in 7 d
                </span>
              </summary>
              <div className="mt-3 grid gap-3">
                <p className="text-ui-meta tabular-nums text-muted-foreground">
                  {provider.counted24h} counted in 24 h / {provider.byKind.rate_limit ?? 0}{' '}
                  rate-limited in 7 d / {provider.consecutive} since last success or resume
                </p>
                <p className="break-words text-ui-secondary text-muted-foreground">
                  Last error:{' '}
                  {provider.lastError ??
                    data?.recent.find((failure) => failure.providerId === provider.providerId)
                      ?.message ??
                    provider.paused?.lastError ??
                    'Outside the recent history window.'}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-ui-meta tabular-nums">
                    <caption className="sr-only">
                      Failures by model for {names.get(provider.providerId)}
                    </caption>
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Model</th>
                        <th className="pr-4 font-medium">24 h</th>
                        <th className="pr-4 font-medium">7 d</th>
                        <th className="font-medium">Kinds</th>
                      </tr>
                    </thead>
                    <tbody>
                      {provider.models.map((model) => (
                        <tr key={model.modelRef}>
                          <td className="py-2 pr-4">
                            {model.modelRef}{' '}
                            {model.failing && (
                              <UiV2.Badge variant="destructive">Failing</UiV2.Badge>
                            )}
                          </td>
                          <td className="pr-4">{model.failed24h}</td>
                          <td className="pr-4">{model.failed7d}</td>
                          <td>
                            {Object.entries(model.byKind)
                              .map(
                                ([kind, count]) => `${kind.replaceAll('_', ' ')}: ${String(count)}`,
                              )
                              .join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
      {(data?.recent.length ?? 0) > 0 && (
        <div className="grid gap-3">
          <h3 className="text-ui-label">Recent failures</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-ui-meta">
              <caption className="sr-only">20 most recent failed provider attempts</caption>
              <thead>
                <tr className="text-muted-foreground">
                  {['Time', 'Model', 'Kind', 'Status', 'Message'].map((label) => (
                    <th className="py-2 pr-4 font-medium last:pr-0" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.recent.map((failure) => (
                  <tr key={failure.id}>
                    <td className="whitespace-nowrap py-2 pr-4 tabular-nums">
                      <time dateTime={failure.at} title={new Date(failure.at).toLocaleString()}>
                        {new Date(failure.at).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </td>
                    <td className="py-2 pr-4">{failure.modelRef}</td>
                    <td className="whitespace-nowrap py-2 pr-4">
                      {failure.kind.replaceAll('_', ' ')}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{failure.statusCode ?? '—'}</td>
                    <td className="break-words py-2 text-muted-foreground">{failure.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
