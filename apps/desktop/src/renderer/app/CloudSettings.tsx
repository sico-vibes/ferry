import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useSettings } from '../data/queries';

export function CloudSettings() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const { data: settings } = useSettings();
  const { data: status, refetch } = useQuery({
    queryKey: ['cloud-status'],
    queryFn: () => client.cloud.status(),
  });
  useEffect(
    () =>
      client.on('cloud.status', (nextStatus) => {
        cache.setQueryData(['cloud-status'], nextStatus);
      }),
    [cache, client],
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const mode = status?.storageMode ?? settings?.storageMode ?? 'local';
  const capture = settings?.captureContent ?? mode === 'cloud';
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'migrated' in result) {
        const counts = result as { migrated: number; missing: number; failed: number };
        setFeedback(
          `Copied ${String(counts.migrated)} keys; ${String(counts.missing)} missing; ${String(counts.failed)} failed.`,
        );
      }
      await refetch();
      await cache.invalidateQueries({ queryKey: ['settings'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cloud operation failed.');
    } finally {
      setBusy(false);
    }
  };
  const signIn = async (event: import('react').SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedPassword = password;
    setPassword('');
    await run(() =>
      client.cloud.signIn({
        email: email.length ? email : (status?.ownerEmail ?? ''),
        password: submittedPassword,
      }),
    );
  };
  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border p-4">
        <h3 className="font-medium">Storage mode</h3>
        <p className="muted mt-1">
          Local keeps data on this device. Cloud syncs through your signed-in Ferry account.
        </p>
        <div className="mt-3 flex gap-2">
          {(['local', 'cloud'] as const).map((value) => (
            <UiV2.Button
              key={value}
              size="sm"
              variant={mode === value ? 'default' : 'outline'}
              aria-pressed={mode === value}
              disabled={busy || mode === value}
              onClick={() => void run(() => client.cloud.setStorageMode({ mode: value }))}
            >
              {value === 'local' ? 'Local' : 'Cloud'}
            </UiV2.Button>
          ))}
        </div>
        <p className="muted mt-2">Restart Ferry to apply a storage mode change.</p>
        {mode === 'cloud' && !status?.configured && (
          <p role="status" className="mt-2">
            Cloud configuration is missing. Set FERRY_SUPABASE_URL and
            FERRY_SUPABASE_PUBLISHABLE_KEY.
          </p>
        )}
      </section>
      {mode === 'cloud' && status?.configured && (
        <section className="rounded-lg border border-border p-4">
          <h3 className="font-medium">Cloud account</h3>
          {status.auth.signedIn ? (
            <div className="mt-3 space-y-2">
              <p>
                {status.auth.email}{' '}
                {status.auth.isOwner && (
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">Owner</span>
                )}
              </p>
              <div className="flex gap-2">
                <UiV2.Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void run(() => client.cloud.signOut());
                  }}
                >
                  Sign out
                </UiV2.Button>
                <UiV2.Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void run(() => client.cloud.syncNow());
                  }}
                >
                  Sync now
                </UiV2.Button>
              </div>
              <p className="muted">
                {status.sync.pending} pending · {status.sync.failed} failed · Last sync:{' '}
                {status.sync.lastFlush ?? 'never'}
              </p>
              {status.sync.lastError && <p role="alert">{status.sync.lastError}</p>}
              <UiV2.Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void run(() => client.cloud.migrateLocalKeys());
                }}
              >
                Copy local API keys to cloud Vault
              </UiV2.Button>
            </div>
          ) : status.message?.startsWith('Restart Ferry') ? (
            <p role="status" className="mt-3">
              {status.message}
            </p>
          ) : (
            <form
              className="mt-3 space-y-2"
              onSubmit={(event) => {
                void signIn(event);
              }}
            >
              <label className="block">
                Email
                <input
                  className="mt-1 w-full rounded border border-input bg-background px-3 py-2"
                  type="email"
                  autoComplete="username"
                  value={email.length ? email : (status.ownerEmail ?? '')}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  required
                />
              </label>
              <label className="block">
                Password
                <input
                  className="mt-1 w-full rounded border border-input bg-background px-3 py-2"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                  required
                />
              </label>
              <UiV2.Button size="sm" disabled={busy} type="submit">
                {busy ? 'Signing in…' : 'Sign in'}
              </UiV2.Button>
            </form>
          )}
        </section>
      )}
      <section className="rounded-lg border border-border p-4">
        <h3 className="font-medium">Content capture</h3>
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={capture}
            disabled={busy}
            onChange={(event) =>
              void run(() => client.cloud.setCaptureContent({ value: event.target.checked }))
            }
          />
          Capture full content
        </label>
        <p className="muted mt-1">
          Defaults to {mode === 'cloud' ? 'on' : 'off'} in {mode} mode. Secrets are always redacted.
        </p>
      </section>
      {error && <p role="alert">{error}</p>}
      {feedback && <p role="status">{feedback}</p>}
    </div>
  );
}
