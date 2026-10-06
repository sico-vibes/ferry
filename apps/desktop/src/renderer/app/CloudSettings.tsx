import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SegmentedControl, Switch, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useSettings } from '../data/queries';

function Section({
  title,
  helper,
  children,
}: {
  title: string;
  helper: string;
  children: ReactNode;
}) {
  return (
    <section className="profile-section">
      <header>
        <h3>{title}</h3>
        <p>{helper}</p>
      </header>
      {children}
    </section>
  );
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Storage & Cloud settings: storage mode, cloud account, sync status and content capture. */
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
          `Copied ${String(counts.migrated)} keys to Vault. ${String(counts.missing)} missing, ${String(counts.failed)} failed.`,
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
  const signIn = async (event: React.SyntheticEvent<HTMLFormElement>) => {
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
    <div className="profile-settings-v3">
      <Section
        title="Storage mode"
        helper="Local keeps everything on this device. Cloud also syncs sessions, settings, logs and API keys to your Ferry account."
      >
        <SegmentedControl
          label="Storage mode"
          value={mode}
          onValueChange={(value) => {
            if (value !== mode)
              void run(() => client.cloud.setStorageMode({ mode: value as 'local' | 'cloud' }));
          }}
          options={[
            { value: 'local', label: 'Local', disabled: busy },
            { value: 'cloud', label: 'Cloud', disabled: busy },
          ]}
        />
        <p className="muted">Restart Ferry to apply a storage mode change.</p>
        {mode === 'cloud' && !status?.configured ? (
          <p className="profile-locked-note" role="status">
            <span>
              Cloud is not configured on this device. Add FERRY_SUPABASE_URL and
              FERRY_SUPABASE_PUBLISHABLE_KEY to cloud.env in Ferry&apos;s data folder, then restart.
            </span>
          </p>
        ) : null}
      </Section>

      {mode === 'cloud' && status?.configured ? (
        <Section
          title="Cloud account"
          helper="Sign in to sync. While signed out, Ferry keeps working locally and uploads later."
        >
          {status.auth.signedIn ? (
            <>
              <div className="setting-row">
                <div>
                  <strong>
                    {status.auth.email}
                    {status.auth.isOwner ? (
                      <span className="model-free-pill ml-2">Owner</span>
                    ) : null}
                  </strong>
                  <small>
                    {status.sync.pending} pending · {status.sync.failed} failed · last sync{' '}
                    {formatSyncTime(status.sync.lastFlush)}
                  </small>
                </div>
                <div className="button-row">
                  <UiV2.Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => client.cloud.syncNow())}
                  >
                    Sync now
                  </UiV2.Button>
                  <UiV2.Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(() => client.cloud.signOut())}
                  >
                    Sign out
                  </UiV2.Button>
                </div>
              </div>
              {status.sync.lastError ? (
                <p className="v2-settings-save-error" role="alert">
                  {status.sync.lastError}
                </p>
              ) : null}
              <div className="setting-row">
                <div>
                  <strong>API keys in Vault</strong>
                  <small>
                    Copy keys saved on this device to your account. Local copies stay as a fallback
                    for when you are offline.
                  </small>
                </div>
                <UiV2.Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run(() => client.cloud.migrateLocalKeys())}
                >
                  Copy local keys to Vault
                </UiV2.Button>
              </div>
            </>
          ) : status.message?.startsWith('Restart Ferry') ? (
            <p role="status">{status.message}</p>
          ) : (
            <form className="profile-grid" onSubmit={(event) => void signIn(event)}>
              <label className="v2-settings-field">
                <span>Email</span>
                <UiV2.Input
                  type="email"
                  autoComplete="username"
                  required
                  value={email.length ? email : (status.ownerEmail ?? '')}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                />
              </label>
              <label className="v2-settings-field">
                <span>Password</span>
                <UiV2.Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                />
              </label>
              <div>
                <UiV2.Button disabled={busy} type="submit">
                  {busy ? 'Signing in…' : 'Sign in'}
                </UiV2.Button>
              </div>
            </form>
          )}
        </Section>
      ) : null}

      <Section
        title="Content capture"
        helper={`Full prompts, replies, reasoning and tool output in logs. Defaults to ${mode === 'cloud' ? 'on' : 'off'} in ${mode} mode. API keys are always redacted.`}
      >
        <div className="setting-row">
          <div>
            <strong>Capture full content</strong>
            <small>Off records only metadata such as models, timings, tokens and errors.</small>
          </div>
          <Switch
            label="Capture full content"
            checked={capture}
            onCheckedChange={(value) => void run(() => client.cloud.setCaptureContent({ value }))}
          />
        </div>
      </Section>

      {error ? (
        <p className="v2-settings-save-error" role="alert">
          {error}
        </p>
      ) : null}
      {feedback ? (
        <p className="v2-settings-save-success" role="status">
          {feedback}
        </p>
      ) : null}
    </div>
  );
}
