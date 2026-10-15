import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Terminal } from 'lucide-react';
import { UiV2 } from '@ferry/ui';
import { ProviderIdSchema } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { useSettings } from '../data/queries';

export function ZenCliConnection() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const { data: settings } = useSettings();
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['zen-cli-status'],
    queryFn: () => client.providers.zenCliStatus(),
    retry: false,
  });
  const { data: models = [] } = useQuery({
    queryKey: ['models', 'opencode'],
    queryFn: () => client.models.list(ProviderIdSchema.parse('opencode')),
  });
  const [selected, setSelected] = useState('');
  const freeModels = data?.freeModels ?? models.filter((model) => model.free);
  const cliConnections = settings?.cliConnections;
  const connection = cliConnections?.['opencode-cli'];
  const nativeEnabled = connection?.native ?? false;
  const gatewayEnabled = connection?.gateway ?? false;
  const credentialMode = connection?.credentialMode ?? 'installed';
  const invalidate = () =>
    Promise.all(
      [
        'settings',
        'providers',
        'models',
        'model-candidates',
        'zen-cli-status',
        'cli-connections',
        'quota',
      ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
    );
  const toggle = async (surface: 'native' | 'gateway', enabled: boolean) => {
    setChecking(true);
    try {
      const surfaces = { native: nativeEnabled, gateway: gatewayEnabled, [surface]: enabled };
      await client.cliConnections.update('opencode-cli', { surfaces });
      // Keep the old transport hint in step with the shared manager while old model references
      // are retained. Eligibility and permissions come from the independent surface opt-ins.
      await client.settings.update({
        opencodeZenTransport: surfaces.native || surfaces.gateway ? 'cli' : 'api',
      });
      await invalidate();
      setMessage(
        enabled
          ? `OpenCode CLI enabled for ${surface === 'native' ? 'Ferry chat and CLI' : 'Gateway requests'}. Verify a free model to use it.`
          : `OpenCode CLI disabled for ${surface === 'native' ? 'Ferry chat and CLI' : 'Gateway requests'}.`,
      );
    } catch {
      setMessage('Could not change Zen connection mode. Retry.');
    } finally {
      setChecking(false);
    }
  };
  const changeCredential = async (mode: 'installed' | 'anonymous' | 'ferry') => {
    setChecking(true);
    try {
      await client.cliConnections.update('opencode-cli', {
        credentialMode: mode,
        credentialProvider: null,
      });
      await client.settings.update({ opencodeZenCliUseFerryKey: mode === 'ferry' });
      await invalidate();
      setMessage('Credential source changed. Verify CLI access again.');
    } catch {
      setMessage('Could not update the CLI credential source. Retry.');
    } finally {
      setChecking(false);
    }
  };
  const detect = async () => {
    setChecking(true);
    setMessage('Detecting the installed OpenCode client…');
    try {
      const inventory = await client.cliConnections.refresh('opencode-cli');
      await invalidate();
      await refetch();
      setMessage(
        inventory.find((item) => item.kind === 'opencode-cli')?.install.installed
          ? 'Detection complete. Verify a free model to check access.'
          : 'OpenCode was not detected. Install the CLI, then detect again.',
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not detect OpenCode. Retry.');
    } finally {
      setChecking(false);
    }
  };
  const offerGoCredential = async (enabled: boolean) => {
    setChecking(true);
    try {
      await client.cliConnections.update('opencode-cli', {
        credentialProvider: enabled ? 'opencode-go' : null,
      });
      await invalidate();
      setMessage('Credential source changed. Verify CLI access again.');
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : 'Could not change the credential source.',
      );
    } finally {
      setChecking(false);
    }
  };
  const verify = async () => {
    setChecking(true);
    setMessage('Waiting for OpenCode to generate one tiny free response…');
    try {
      const result = await client.providers.verifyZenCli(selected || freeModels[0]?.ref);
      setMessage(result.message);
      await invalidate();
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : 'OpenCode verification failed. Check the installation and retry.',
      );
    } finally {
      setChecking(false);
    }
  };
  return (
    <section
      className="grid gap-3 rounded-card border border-border p-4"
      aria-label="OpenCode CLI connection"
    >
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="zen-cli-mode" className="flex items-center gap-2 text-ui-label">
          <Terminal size={16} strokeWidth={1.75} aria-hidden="true" />
          Use installed OpenCode CLI
        </label>
        <UiV2.Switch
          id="zen-cli-mode"
          checked={nativeEnabled}
          disabled={!settings || checking}
          onCheckedChange={(enabled) => {
            void toggle('native', enabled);
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="zen-cli-gateway" className="text-ui-label">
          Allow Zen CLI in Gateway
        </label>
        <UiV2.Switch
          id="zen-cli-gateway"
          checked={gatewayEnabled}
          disabled={!settings || checking}
          onCheckedChange={(enabled) => {
            void toggle('gateway', enabled);
          }}
        />
      </div>
      <p className="text-ui-meta text-muted-foreground">
        Routes Zen free models through the real OpenCode client using ACP. Works in Ferry chat and
        the Gateway API when you enable each surface. Your caller keeps control of tool execution.
        OpenCode Go remains a separate paid connection.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-ui-meta">
        {isFetching ? (
          'Detecting OpenCode…'
        ) : isError ? (
          'Could not detect OpenCode.'
        ) : data?.available ? (
          <>
            <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />
            Installed · {data.version} ·{' '}
            {data.credentialSource === 'opencode'
              ? 'OpenCode Zen credential found'
              : data.credentialSource === 'opencode_go'
                ? data.verifiedModels.length
                  ? 'OpenCode Go credential found; free-model verification is shown below'
                  : 'OpenCode Go credential found; Zen access not checked'
                : data.credentialSource === 'ferry'
                  ? 'Uses saved Ferry key'
                  : 'Anonymous access available to check; no OpenCode credential detected'}
          </>
        ) : (
          'OpenCode CLI not installed.'
        )}
        <UiV2.Button
          variant="secondary"
          size="sm"
          disabled={isFetching || checking}
          onClick={() => {
            void detect();
          }}
        >
          Detect again
        </UiV2.Button>
      </div>
      {settings && (
        <>
          <label className="grid gap-2 text-ui-meta">
            Zen CLI credential source
            <select
              aria-label="Zen CLI credential source"
              className="rounded-control border border-input bg-background px-3 py-2"
              value={credentialMode}
              disabled={checking}
              onChange={(event) => {
                const mode = event.target.value;
                if (mode === 'installed' || mode === 'anonymous' || mode === 'ferry')
                  void changeCredential(mode);
              }}
            >
              <option value="installed">Installed CLI credentials</option>
              <option value="anonymous">Anonymous free access</option>
              <option value="ferry">Zen key saved in Ferry</option>
            </select>
          </label>
          <p className="text-ui-meta text-muted-foreground">
            Choose the credential used for the access check. Changing it requires verification
            again; a stored Go key does not itself prove Zen access.
          </p>
          {credentialMode === 'installed' && data?.credentialSource === 'opencode_go' && (
            <label className="flex items-center justify-between gap-3 text-ui-meta">
              <span>Offer the installed Go credential for the Zen check</span>
              <UiV2.Switch
                aria-label="Offer OpenCode Go credential to Zen"
                checked={connection?.credentialProvider === 'opencode-go'}
                disabled={checking}
                onCheckedChange={(enabled) => {
                  void offerGoCredential(enabled);
                }}
              />
            </label>
          )}
          <label className="grid gap-2 text-ui-meta">
            Free model to verify
            <select
              className="rounded-control border border-input bg-background px-3 py-2"
              value={selected || (freeModels[0]?.ref ?? '')}
              onChange={(event) => {
                setSelected(event.target.value);
              }}
              disabled={checking}
            >
              {freeModels.map((model) => (
                <option key={model.ref} value={model.ref}>
                  {model.name}
                  {data?.verifiedModels.includes(model.ref) ? ' · CLI verified' : ''}
                </option>
              ))}
            </select>
          </label>
          <UiV2.Button
            variant="secondary"
            disabled={checking || !data?.available || !freeModels.length}
            onClick={() => {
              void verify();
            }}
          >
            {checking ? 'Waiting for OpenCode…' : 'Verify free CLI access'}
          </UiV2.Button>
          <p className="text-ui-meta text-muted-foreground">
            One small free generation. Only verified models become selectable; there is no paid
            fallback. Text and caller tools are supported; images and structured response formats
            require the API connection.
          </p>
        </>
      )}
      <p role="status" aria-live="polite" className="text-ui-meta text-muted-foreground">
        {message}
      </p>
      <details className="text-ui-meta text-muted-foreground">
        <summary className="cursor-pointer text-ui-label">Install or sign in</summary>
        <p className="mt-2">
          Install OpenCode from{' '}
          <a
            href="https://opencode.ai/docs/"
            target="_blank"
            rel="noreferrer"
            className="text-link underline"
          >
            the official guide
          </a>
          . Run <code>opencode auth login</code> and select OpenCode Zen, or keep your Zen key saved
          in Ferry. Then detect and verify above. A Go subscription is not required to test the
          currently available free models.
        </p>
      </details>
    </section>
  );
}
