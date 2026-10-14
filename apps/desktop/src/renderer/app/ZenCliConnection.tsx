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
  const cliMode = settings?.opencodeZenTransport === 'cli';
  const invalidate = () =>
    Promise.all(
      ['settings', 'providers', 'models', 'model-candidates', 'zen-cli-status', 'quota'].map(
        (key) => cache.invalidateQueries({ queryKey: [key] }),
      ),
    );
  const toggle = async (enabled: boolean) => {
    setChecking(true);
    try {
      await client.settings.update({ opencodeZenTransport: enabled ? 'cli' : 'api' });
      await invalidate();
      setMessage(
        enabled
          ? 'CLI mode enabled for Ferry chat and Gateway. Verify a free model below to make it selectable.'
          : 'Standard API mode enabled. CLI-only models are excluded from routing.',
      );
    } catch {
      setMessage('Could not change Zen connection mode. Retry.');
    } finally {
      setChecking(false);
    }
  };
  const toggleKey = async (enabled: boolean) => {
    setChecking(true);
    try {
      await client.settings.update({ opencodeZenCliUseFerryKey: enabled });
      await invalidate();
      setMessage('Credential source changed. Verify CLI access again.');
    } catch {
      setMessage('Could not update the CLI credential source. Retry.');
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
          checked={cliMode}
          disabled={!settings || checking}
          onCheckedChange={(enabled) => void toggle(enabled)}
        />
      </div>
      <p className="text-ui-meta text-muted-foreground">
        Routes Zen free models through the real OpenCode client using ACP. Works in Ferry chat and
        the Gateway API. Your caller keeps control of tool execution. OpenCode Go remains a separate
        paid connection.
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
          onClick={() => void refetch()}
        >
          Detect again
        </UiV2.Button>
      </div>
      {cliMode && (
        <>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="zen-cli-ferry-key" className="text-ui-meta">
              Use saved Ferry Zen key
            </label>
            <UiV2.Switch
              id="zen-cli-ferry-key"
              checked={settings.opencodeZenCliUseFerryKey}
              disabled={checking}
              onCheckedChange={(enabled) => void toggleKey(enabled)}
            />
          </div>
          <p className="text-ui-meta text-muted-foreground">
            By default, OpenCode uses its own Zen credential or anonymous free access. Enable the
            saved-key option to supply your Ferry key when the CLI has no Zen credential.
          </p>
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
            onClick={() => void verify()}
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
