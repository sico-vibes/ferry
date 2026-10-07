import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CloudStatus } from '@ferry/client';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';

export const cloudStatusKey = ['cloud-status'] as const;

/** Live cloud status: fetched once, then kept current by the engine's cloud.status events. */
export function useCloudStatus() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const query = useQuery({ queryKey: cloudStatusKey, queryFn: () => client.cloud.status() });
  useEffect(
    () =>
      client.on('cloud.status', (next) => {
        cache.setQueryData(cloudStatusKey, next);
      }),
    [cache, client],
  );
  return query;
}

/** The saved storage mode only takes effect after a restart; offer it right where it matters. */
export function RestartNotice({ status }: { status: CloudStatus | undefined }) {
  const [restarting, setRestarting] = useState(false);
  if (!status?.pendingMode) return null;
  const target = status.pendingMode === 'cloud' ? 'Ferry Cloud' : 'this device only';
  return (
    <div className="profile-locked-note" role="status">
      <span>
        Restart Ferry to switch storage to {target}. Your chats and keys stay on this device.
      </span>
      {window.ferryHost ? (
        <UiV2.Button
          size="sm"
          disabled={restarting}
          onClick={() => {
            setRestarting(true);
            void window.ferryHost?.relaunch();
          }}
        >
          {restarting ? 'Restarting…' : 'Restart now'}
        </UiV2.Button>
      ) : null}
    </div>
  );
}

/** Email + password sign-in to Ferry Cloud. The password is cleared as soon as it is submitted. */
export function CloudSignInForm({
  ownerEmail,
  onSignedIn,
}: {
  ownerEmail: string | null;
  onSignedIn?: () => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedPassword = password;
    setPassword('');
    setBusy(true);
    setError(null);
    try {
      const next = await client.cloud.signIn({
        email: email.length ? email : (ownerEmail ?? ''),
        password: submittedPassword,
      });
      cache.setQueryData(cloudStatusKey, next);
      onSignedIn?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cloud sign-in failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="profile-grid" onSubmit={(event) => void submit(event)}>
      <label className="v2-settings-field">
        <span>Email</span>
        <UiV2.Input
          type="email"
          autoComplete="username"
          required
          value={email.length ? email : (ownerEmail ?? '')}
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
      <div className="grid gap-2">
        <div>
          <UiV2.Button disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </UiV2.Button>
        </div>
        {error ? (
          <p className="v2-settings-save-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
