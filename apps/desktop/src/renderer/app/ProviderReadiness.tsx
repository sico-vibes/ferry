import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ProfileIdSchema, type Profile } from '@ferry/shared';
import { UiV2 } from '@ferry/ui';
import { CheckCircle2 } from 'lucide-react';
import { ProviderCheckResults } from './ProviderCheckResults';
import { useUI } from '../state/ui';
import { useFerryClient } from '../data/client';

/** Core selects and executes free representative models, with shared bounded cancellation. */
export function ProviderReadiness() {
  const client = useFerryClient(),
    cache = useQueryClient();
  const [id, setId] = useState<string | undefined>();
  const [starting, setStarting] = useState(false),
    [error, setError] = useState('');
  const [paidCap, setPaidCap] = useState('0.01');
  const [paidApproved, setPaidApproved] = useState(false);
  const [preview, setPreview] = useState<Profile | null>(null),
    [built, setBuilt] = useState('');
  const mutation = useRef(false);
  const [applying, setApplying] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null),
    [applied, setApplied] = useState(false);
  const checks = useQuery({
    queryKey: ['provider-check', id ?? 'latest'],
    queryFn: () => client.providers.checkProgress(id),
    refetchInterval: (query) => (query.state.data?.running ? 500 : false),
  });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => client.profiles.list() });
  const checkId = checks.data?.id;
  const busy = starting || applying || !!checks.data?.running;
  useEffect(
    () =>
      client.on('providers.check', (progress) => {
        cache.setQueryData(['provider-check', progress.id], progress);
        cache.setQueryData(['provider-check', 'latest'], progress);
        if (!progress.running) {
          void cache.invalidateQueries({ queryKey: ['models'] });
          void cache.invalidateQueries({ queryKey: ['providers'] });
          void cache.invalidateQueries({ queryKey: ['model-candidates'] });
        }
      }),
    [client, cache],
  );
  useEffect(() => {
    const progress = checks.data;
    if (progress && !progress.running && (progress.cancelled || !progress.results.length)) {
      setPreview(null);
      return;
    }
    const base = profiles.data?.find((profile) => profile.builtin && profile.name === 'Auto-Free');
    if (
      !progress ||
      progress.running ||
      progress.cancelled ||
      progress.id === built ||
      !base ||
      !progress.results.length
    )
      return;
    setBuilt(progress.id);
    const good = progress.results
      .filter((result) => result.ok && !result.paid)
      .sort((a, b) => (a.firstResponseMs ?? Infinity) - (b.firstResponseMs ?? Infinity));
    if (!good.length) return;
    setPreview({
      ...base,
      id: ProfileIdSchema.parse(`profile_optimized_${crypto.randomUUID().replaceAll('-', '_')}`),
      name: 'Optimized for this device',
      builtin: false,
      roles: { ...base.roles, enabled: false },
      routingObjective: 'balanced',
      allowedProviders: good.map(
        (result) => result.providerId as import('@ferry/shared').ProviderId,
      ),
      fallbackChain: good.map((result) => ({
        provider: result.providerId as import('@ferry/shared').ProviderId,
        patterns: [result.modelRef.slice(result.providerId.length + 1)],
      })),
      provenance: {
        kind: 'provider-check',
        generatedAt: progress.results.at(-1)?.at ?? new Date().toISOString(),
        sampleCount: progress.results.reduce((count, result) => count + result.sampleCount, 0),
        note: 'One generation per connection measures responsiveness, not coding quality. Auto edits and verification continue to prefer measured coding success.',
      },
    });
  }, [checks.data, profiles.data, built]);
  const start = async (paid = false) => {
    if (busy) return;
    setStarting(true);
    setError('');
    setPreview(null);
    setApplied(false);
    setUndoId(null);
    try {
      const result = await client.providers.startChecks(
        paid ? { approvedCostUsd: Number(paidCap) } : undefined,
      );
      setPaidApproved(false);
      setId(result.id);
      await cache.invalidateQueries({ queryKey: ['provider-check'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start checks.');
    } finally {
      setStarting(false);
    }
  };
  return (
    <section className="provider-readiness grid gap-3" aria-label="Provider readiness checks">
      <h3>Check and optimize my providers</h3>
      <p className="v2-gateway-help">
        One small generation per eligible free provider, at most two at once. Other connections show
        why they are skipped. A response-time sample does not measure coding quality.
      </p>
      <div className="button-row">
        <UiV2.Button variant="secondary" disabled={busy} onClick={() => void start()}>
          {busy ? 'Checking…' : 'Check free providers'}
        </UiV2.Button>
        {busy && checkId && (
          <UiV2.Button
            variant="ghost"
            onClick={() =>
              void client.providers
                .cancelChecks(checkId)
                .then(() => cache.invalidateQueries({ queryKey: ['provider-check'] }))
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : 'Could not cancel checks.');
                })
            }
          >
            Cancel checks
          </UiV2.Button>
        )}
      </div>
      <details className="settings-developer-details">
        <summary>Paid checks</summary>
        <div className="grid gap-3">
          <p className="v2-gateway-help">
            Paid API checks need a separate approval. The total ceiling covers this operation, at
            most two requests at once. They never enable paid inference or apply paid routes.
            Account models use the Gateway verification flow.
          </p>
          <label className="grid gap-2">
            Total test ceiling (USD)
            <UiV2.Input
              aria-label="Total test ceiling (USD)"
              type="number"
              min="0.000001"
              max="1"
              step="0.01"
              value={paidCap}
              onChange={(event) => {
                setPaidCap(event.target.value);
                setPaidApproved(false);
              }}
            />
          </label>
          <label className="flex items-center gap-3">
            <UiV2.Checkbox
              checked={paidApproved}
              onCheckedChange={(value) => {
                setPaidApproved(value === true);
              }}
            />
            I approve paid checks up to this total ceiling
          </label>
          <UiV2.Button
            variant="secondary"
            disabled={
              busy ||
              !paidApproved ||
              !Number.isFinite(Number(paidCap)) ||
              Number(paidCap) <= 0 ||
              Number(paidCap) > 1
            }
            onClick={() => void start(true)}
          >
            Check paid API providers
          </UiV2.Button>
        </div>
      </details>
      {checks.isError && (
        <p role="alert">
          Could not load check results.{' '}
          <UiV2.Button variant="secondary" onClick={() => void checks.refetch()}>
            Retry
          </UiV2.Button>
        </p>
      )}
      {checks.data && <ProviderCheckResults progress={checks.data} />}
      {checks.data?.cancelled && (
        <p role="status">Checks cancelled. No recommendations will be applied.</p>
      )}
      {preview && (
        <div className="grid gap-3">
          <h3>Preview: Optimized for this device</h3>
          <p className="v2-gateway-help">
            {preview.provenance?.note} {String(preview.provenance?.sampleCount)} samples. Fallback
            order: {preview.fallbackChain?.map((entry) => entry.provider).join(', ')}.
          </p>
          {applied && (
            <div className="provider-recommendation-applied" role="status">
              <CheckCircle2 size={20} aria-hidden="true" />
              <div>
                <strong>Optimized profile is active</strong>
                <p>
                  Your default Ferry agent profile now uses the checked providers in this order.
                  Existing Gateway keys keep their assigned profile.
                </p>
                <UiV2.Button
                  variant="ghost"
                  onClick={() => {
                    useUI.getState().openSettings('Profiles');
                  }}
                >
                  Edit profile
                </UiV2.Button>
              </div>
            </div>
          )}
          <div className="button-row">
            <UiV2.Button
              variant="secondary"
              disabled={applied || applying || busy}
              onClick={() =>
                void (async () => {
                  if (mutation.current || applied) return;
                  mutation.current = true;
                  setApplying(true);
                  setError('');
                  try {
                    const current = await client.providers.checkProgress(checkId);
                    if (
                      current.running ||
                      current.cancelled ||
                      current.results.at(-1)?.at !== preview.provenance?.generatedAt ||
                      JSON.stringify(
                        current.results
                          .filter((result) => result.ok && !result.paid)
                          .map((result) => result.modelRef)
                          .sort(),
                      ) !==
                        JSON.stringify(
                          preview.fallbackChain
                            ?.flatMap((entry) =>
                              entry.patterns.map((model) => `${entry.provider}/${model}`),
                            )
                            .sort(),
                        )
                    )
                      throw new Error('These recommendations are stale. Check providers again.');
                    const result = await client.profiles.applyOptimized(preview);
                    setPreview(result.profile);
                    setUndoId(result.undoId);
                    setApplied(true);
                    await cache.invalidateQueries({ queryKey: ['profiles'] });
                    await cache.invalidateQueries({ queryKey: ['settings'] });
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : 'Could not apply recommendations.',
                    );
                  } finally {
                    mutation.current = false;
                    setApplying(false);
                  }
                })()
              }
            >
              {applying && !applied ? 'Applying…' : 'Apply recommendations'}
            </UiV2.Button>
            {applied && undoId && (
              <UiV2.Button
                variant="ghost"
                disabled={applying}
                onClick={() =>
                  void (async () => {
                    if (mutation.current) return;
                    mutation.current = true;
                    setApplying(true);
                    setError('');
                    try {
                      await client.profiles.undoOptimized(undoId);
                      setApplied(false);
                      setUndoId(null);
                      await cache.invalidateQueries({ queryKey: ['profiles'] });
                      await cache.invalidateQueries({ queryKey: ['settings'] });
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : 'Could not undo.');
                    } finally {
                      mutation.current = false;
                      setApplying(false);
                    }
                  })()
                }
              >
                Undo
              </UiV2.Button>
            )}
          </div>
        </div>
      )}
      {(error || checks.data?.error) && <p role="status">{error || checks.data?.error}</p>}
    </section>
  );
}
