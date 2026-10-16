import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isCliModelVerified,
  type CliConnection,
  type CliConnectionKind,
  type CliConnectionSettingsPatch,
  type ModelRef,
} from '@ferry/shared';
import { Dialog, ProviderLogo, UiV2 } from '@ferry/ui';
import { BadgeCheck, CircleAlert, RefreshCw, Terminal } from 'lucide-react';
import { useFerryClient } from '../data/client';

export const cliConnectionNames = {
  'codex-cli': 'Codex CLI',
  'claude-code-cli': 'Claude Code CLI',
  'opencode-cli': 'OpenCode CLI',
} as const;
export const cliLogoProvider = {
  'codex-cli': 'codex-cli',
  'claude-code-cli': 'claude-code-cli',
  'opencode-cli': 'opencode',
} as const;
const signInCommands = {
  'codex-cli': 'codex login',
  'claude-code-cli': 'claude auth login',
  'opencode-cli': 'opencode auth login',
} as const;
const cliKey = ['cli-connections'] as const;
const quotaNumber = new Intl.NumberFormat();
const quotaResetDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function InstalledCliConnections() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'refresh' | 'verify' | 'update' | null>(null);
  const [error, setError] = useState('');
  const [signIn, setSignIn] = useState<CliConnectionKind | null>(null);
  const [selected, setSelected] = useState<Record<string, ModelRef>>({});
  const connections = useQuery({
    queryKey: cliKey,
    queryFn: () => client.cliConnections.list(),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => client.settings.get(),
    staleTime: 60_000,
    retry: false,
  });
  useEffect(
    () =>
      client.on('cliConnections.updated', (connection) => {
        cache.setQueryData<CliConnection[]>(
          cliKey,
          (previous) =>
            previous?.map((item) => (item.id === connection.id ? connection : item)) ?? [
              connection,
            ],
        );
      }),
    [client, cache],
  );
  const invalidateModels = () =>
    Promise.all(
      ['providers', 'models', 'model-candidates', 'quota', 'gateway-activity'].map((key) =>
        cache.invalidateQueries({ queryKey: [key] }),
      ),
    );
  const refresh = async (id?: CliConnectionKind) => {
    setBusy(id ?? 'all');
    setBusyAction('refresh');
    setError('');
    try {
      cache.setQueryData(cliKey, await client.cliConnections.refresh(id));
      await invalidateModels();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Detection failed. Try again.');
    } finally {
      setBusy(null);
      setBusyAction(null);
    }
  };
  const update = async (
    connection: CliConnection,
    surface: 'native' | 'gateway',
    enabled: boolean,
  ) => {
    setBusy(connection.id);
    setBusyAction('update');
    setError('');
    try {
      const result = await client.cliConnections.update(connection.id, {
        surfaces: { ...connection.surfaces, [surface]: enabled },
      });
      cache.setQueryData<CliConnection[]>(cliKey, (previous) =>
        previous?.map((item) => (item.id === result.id ? result : item)),
      );
      await invalidateModels();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update this connection.');
    } finally {
      setBusy(null);
      setBusyAction(null);
    }
  };
  const verify = async (connection: CliConnection) => {
    setBusy(connection.id);
    setBusyAction('verify');
    setError('');
    try {
      const model =
        selected[connection.id] ??
        connection.models.find(
          (item) =>
            !item.hidden && (item.billing === 'free' || item.billing === 'included_subscription'),
        )?.ref;
      if (!model) throw new Error('No free or included model is available to verify.');
      const result = await client.cliConnections.verify(connection.id, model);
      if (!result.ok) setError(result.message);
      await connections.refetch();
      await invalidateModels();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Verification failed. Refresh the connection and retry.',
      );
    } finally {
      setBusy(null);
      setBusyAction(null);
    }
  };
  const changeCredential = async (patch: CliConnectionSettingsPatch) => {
    setBusy('opencode-cli');
    setBusyAction('update');
    setError('');
    try {
      const result = await client.cliConnections.update('opencode-cli', patch);
      cache.setQueryData<CliConnection[]>(cliKey, (previous) =>
        previous?.map((item) => (item.id === result.id ? result : item)),
      );
      await cache.invalidateQueries({ queryKey: ['settings'] });
      await invalidateModels();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the credential source.');
    } finally {
      setBusy(null);
      setBusyAction(null);
    }
  };
  return (
    <section className="installed-clis" aria-label="Installed CLIs">
      <header className="installed-clis-header">
        <div>
          <h3>Installed CLIs</h3>
          <p>
            Use the accounts already connected to your coding clients. Verify a model, then choose
            where Ferry can use it.
          </p>
        </div>
        <UiV2.Button
          variant="secondary"
          disabled={busy !== null || connections.isFetching}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          {busy === 'all' ? 'Detecting…' : 'Detect / Refresh'}
        </UiV2.Button>
      </header>
      {error && (
        <p className="installed-clis-error" role="alert">
          {error}
        </p>
      )}
      {connections.isPending ? (
        <p role="status">Loading saved CLI connections…</p>
      ) : connections.isError ? (
        <p role="alert">
          CLI connections could not load.{' '}
          <UiV2.Button variant="ghost" onClick={() => void connections.refetch()}>
            Retry
          </UiV2.Button>
        </p>
      ) : (
        connections.data.map((connection) => {
          const name = cliConnectionNames[connection.kind];
          const active = busy === connection.id;
          const models = connection.models.filter((model) => !model.hidden);
          const verifiedCount = models.filter((model) =>
            isCliModelVerified(connection, model.ref),
          ).length;
          const verified = verifiedCount > 0;
          const verificationModels = models.filter(
            (model) => model.billing === 'free' || model.billing === 'included_subscription',
          );
          return (
            <div className="installed-cli-row" key={connection.id}>
              <div className="installed-cli-identity">
                <ProviderLogo name={name} providerId={cliLogoProvider[connection.kind]} size={24} />
                <div>
                  <strong>{name}</strong>
                  <span>
                    {connection.install.installed
                      ? `Installed${connection.install.version ? ` · ${connection.install.version}` : ''}`
                      : connection.lastChecked
                        ? 'Not detected'
                        : 'Detection pending'}
                  </span>
                </div>
                {verified && (
                  <BadgeCheck size={16} strokeWidth={1.75} aria-label="Generation verified" />
                )}
              </div>
              <div className="installed-cli-facts">
                <span>
                  {connection.account.state === 'signed_in'
                    ? (connection.account.label ?? 'Signed in · identity not reported')
                    : connection.account.state === 'signed_out'
                      ? 'Not signed in'
                      : 'Sign-in not confirmed'}
                </span>
                <span>
                  {models.length
                    ? `${String(models.length)} ${models.length === 1 ? 'model' : 'models'} discovered`
                    : 'Models not discovered'}
                </span>
                <span>
                  {verified
                    ? `${String(verifiedCount)} ${verifiedCount === 1 ? 'model' : 'models'} generation verified`
                    : 'Generation not verified'}
                </span>
              </div>
              <div className="installed-cli-actions">
                {verificationModels.length > 0 && (
                  <label className="installed-cli-model">
                    <span className="sr-only">{name} verification model</span>
                    <select
                      aria-label={`${name} verification model`}
                      value={selected[connection.id] ?? verificationModels[0]?.ref}
                      onChange={(event) => {
                        const model = verificationModels.find(
                          (item) => item.ref === event.target.value,
                        );
                        if (!model) return;
                        setSelected((previous) => ({
                          ...previous,
                          [connection.id]: model.ref,
                        }));
                      }}
                      disabled={active}
                    >
                      {verificationModels.map((model) => (
                        <option key={model.ref} value={model.ref}>
                          {model.name}
                          {model.upstreamProvider ? ` · ${model.upstreamProvider}` : ''}
                          {isCliModelVerified(connection, model.ref) ? ' · Verified' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <UiV2.Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    busy !== null || !connection.install.installed || !verificationModels.length
                  }
                  onClick={() => void verify(connection)}
                >
                  {active && busyAction === 'verify' ? 'Waiting for reply…' : 'Verify connection'}
                </UiV2.Button>
                <UiV2.Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void refresh(connection.kind)}
                >
                  Refresh
                </UiV2.Button>
                <UiV2.Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSignIn(connection.kind);
                  }}
                >
                  Sign-in instructions
                </UiV2.Button>
              </div>
              {connection.kind === 'opencode-cli' && (
                <div className="grid gap-3">
                  <label className="installed-cli-model">
                    <span>OpenCode credential source</span>
                    <select
                      aria-label="OpenCode credential source"
                      value={
                        settings.data?.cliConnections['opencode-cli']?.credentialMode ?? 'installed'
                      }
                      disabled={busy !== null || !settings.data}
                      onChange={(event) => {
                        const mode = event.target.value;
                        if (mode !== 'installed' && mode !== 'anonymous' && mode !== 'ferry')
                          return;
                        void changeCredential({ credentialMode: mode, credentialProvider: null });
                      }}
                    >
                      <option value="installed">Installed CLI credentials</option>
                      <option value="anonymous">Anonymous Zen free access</option>
                      <option value="ferry">Zen key saved in Ferry</option>
                    </select>
                  </label>
                  {(settings.data?.cliConnections['opencode-cli']?.credentialMode ??
                    'installed') === 'installed' &&
                    models.some((model) => model.upstreamProvider === 'opencode-go') && (
                      <div className="installed-cli-surfaces">
                        <label>
                          <span>Offer the installed Go credential to Zen</span>
                          <UiV2.Switch
                            aria-label="Offer OpenCode Go credential to Zen"
                            checked={
                              settings.data?.cliConnections['opencode-cli']?.credentialProvider ===
                              'opencode-go'
                            }
                            disabled={busy !== null || !settings.data}
                            onCheckedChange={(enabled) =>
                              void changeCredential({
                                credentialProvider: enabled ? 'opencode-go' : null,
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                  <p className="installed-cli-note">
                    Anonymous mode is limited to Zen free models. A Go credential can be offered for
                    a Zen access check; it does not prove Zen entitlement. Changing credentials
                    requires verification again and does not enable metered spending.
                  </p>
                </div>
              )}
              {active && busyAction === 'verify' && (
                <p className="installed-cli-note" role="status" aria-live="polite">
                  Waiting for {name} to answer one small verification request…
                </p>
              )}
              {connection.verify.message && (
                <p className="installed-cli-note" role="status">
                  {connection.verify.message}
                </p>
              )}
              {connection.discoveryMessage && (
                <p className="installed-cli-note">{connection.discoveryMessage}</p>
              )}
              <div className="installed-cli-surfaces">
                <label>
                  <span>Use in Ferry chat and CLI</span>
                  <UiV2.Switch
                    aria-label={`Use ${name} in Ferry`}
                    checked={connection.surfaces.native}
                    disabled={busy !== null || !connection.install.installed}
                    onCheckedChange={(enabled) => void update(connection, 'native', enabled)}
                  />
                </label>
                <label>
                  <span>Allow Gateway requests</span>
                  <UiV2.Switch
                    aria-label={`Allow ${name} in Gateway`}
                    checked={connection.surfaces.gateway}
                    disabled={busy !== null || !connection.install.installed}
                    onCheckedChange={(enabled) => void update(connection, 'gateway', enabled)}
                  />
                </label>
              </div>
              <div className="installed-cli-usage">
                {connection.usage.state === 'unavailable' ? (
                  <span>
                    Account limits unavailable
                    {connection.usage.note ? ` · ${connection.usage.note}` : ''}
                  </span>
                ) : (
                  <>
                    {connection.usage.state === 'stale' && (
                      <span>
                        <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" /> Limits need
                        refresh
                      </span>
                    )}
                    {connection.usage.windows.length === 0 && (
                      <span>No account limits were reported.</span>
                    )}
                    {connection.usage.windows.map((window) => (
                      <span key={window.id}>
                        {window.label}:{' '}
                        {window.utilization !== null
                          ? `${String(Math.round(window.utilization * 100))}% used`
                          : window.remaining !== null
                            ? `${quotaNumber.format(window.remaining)} ${window.metric} remaining`
                            : 'Not reported'}
                        {window.resetAt
                          ? ` · resets ${quotaResetDate.format(new Date(window.resetAt))}`
                          : ''}
                      </span>
                    ))}
                  </>
                )}
              </div>
            </div>
          );
        })
      )}
      <p className="installed-cli-note">
        Enabling a connection makes it available for selection. Auto uses subscription capacity only
        when your routing profile allows it; metered usage still follows spending permissions.
      </p>
      {signIn && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSignIn(null);
          }}
          title={`Sign in to ${cliConnectionNames[signIn]}`}
        >
          <div className="grid gap-4">
            <p>Open a terminal on this computer and run:</p>
            <pre className="installed-cli-command">
              <Terminal size={16} strokeWidth={1.75} aria-hidden="true" />
              <code>{signInCommands[signIn]}</code>
            </pre>
            <p>
              Finish the client’s login, then return here and choose Refresh. Your credentials stay
              in the client’s existing store.
            </p>
            <UiV2.Button
              variant="secondary"
              onClick={() => {
                setSignIn(null);
              }}
            >
              Done
            </UiV2.Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
