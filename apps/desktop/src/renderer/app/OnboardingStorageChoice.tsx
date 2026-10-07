import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useSettings } from '../data/queries';
import { CloudSignInForm, RestartNotice, cloudStatusKey, useCloudStatus } from './CloudAccount';

/**
 * Onboarding's first decision: keep everything on this device, or sign in to Ferry Cloud so sessions,
 * settings, logs and API keys follow the account. Cloud needs a restart before signing in.
 */
export function StorageChoice({ onContinue }: { onContinue: () => void }) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const { data: settings } = useSettings();
  const { data: status } = useCloudStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = settings?.cloudOnboardingChoice ?? null;
  const choose = async (mode: 'local' | 'cloud') => {
    setBusy(true);
    setError(null);
    try {
      await client.settings.update({ cloudOnboardingChoice: mode });
      if (mode === 'cloud' || status?.storageMode === 'cloud')
        await client.cloud.setStorageMode({ mode });
      await cache.invalidateQueries({ queryKey: keys.settings });
      await cache.invalidateQueries({ queryKey: cloudStatusKey });
      if (mode === 'local') onContinue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your choice.');
    } finally {
      setBusy(false);
    }
  };

  if (choice === 'cloud' && status) {
    if (status.pendingMode) return <RestartNotice status={status} />;
    if (!status.auth.signedIn)
      return (
        <div className="grid w-full max-w-[420px] gap-3 text-left">
          <p className="muted">Sign in to Ferry Cloud to sync this device.</p>
          <CloudSignInForm ownerEmail={status.ownerEmail} />
          <UiV2.Button variant="ghost" disabled={busy} onClick={() => void choose('local')}>
            Use this device only instead
          </UiV2.Button>
        </div>
      );
    return (
      <div className="grid justify-items-center gap-3">
        <p className="muted">Signed in as {status.auth.email}. Sessions and keys will sync.</p>
        <UiV2.Button onClick={onContinue}>Continue</UiV2.Button>
      </div>
    );
  }

  return (
    <div className="grid justify-items-center gap-3">
      <div className="button-row">
        <UiV2.Button disabled={busy} onClick={() => void choose('local')}>
          Continue on this device
        </UiV2.Button>
        {status?.configured ? (
          <UiV2.Button variant="secondary" disabled={busy} onClick={() => void choose('cloud')}>
            Sign in to Ferry Cloud
          </UiV2.Button>
        ) : null}
      </div>
      {status?.configured ? (
        <p className="muted">
          Ferry Cloud keeps sessions, settings, logs and API keys in your account. You can switch
          later in Settings → Storage &amp; Cloud.
        </p>
      ) : null}
      {error ? (
        <p className="v2-settings-save-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
