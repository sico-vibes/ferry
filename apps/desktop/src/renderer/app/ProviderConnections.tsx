import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { providerDefinition, type Provider, type OAuthProvider } from '@ferry/shared';
import { ProviderLogo, Select, SkeletonRows, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { ProviderKeyDialog } from './ProviderKeyDialog';
import { OAuthProviderRows } from './OAuthProviderRows';

/** The same key manager and OAuth progress dialog used by Models and Settings. */
export function ProviderConnections() {
  const client = useFerryClient(),
    cache = useQueryClient();
  const [kind, setKind] = useState('api');
  const [managing, setManaging] = useState<Provider | null>(null);
  const [risk, setRisk] = useState<OAuthProvider | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => client.providers.list() });
  const oauth = useQuery({ queryKey: ['oauth-providers'], queryFn: () => client.oauth.list() });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => client.settings.get() });
  const login = async (provider: OAuthProvider, gateway?: string) => {
    setBusy(provider.id);
    setError('');
    try {
      if (provider.riskLevel === 'high') {
        const settings = await client.settings.get();
        await client.settings.update({
          subscriptionOAuthAcknowledged: [
            ...new Set([...settings.subscriptionOAuthAcknowledged, provider.id]),
          ],
        });
      }
      await client.oauth.login(provider.id, ...(gateway ? [{ gateway }] : []));
      await cache.invalidateQueries({ queryKey: ['oauth-providers'] });
      await cache.invalidateQueries({ queryKey: ['providers'] });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Sign-in failed. Retry or choose another connection.',
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-4">
      <Select
        label="Connection method"
        value={kind}
        onValueChange={setKind}
        options={[
          { value: 'api', label: 'API key or anonymous' },
          { value: 'account', label: 'Account sign-in' },
          { value: 'local', label: 'Local server' },
        ]}
      />
      {providers.isPending ? (
        <SkeletonRows rows={4} />
      ) : providers.isError ? (
        <p role="alert">
          Could not load providers.{' '}
          <UiV2.Button variant="secondary" onClick={() => void providers.refetch()}>
            Retry
          </UiV2.Button>
        </p>
      ) : kind === 'account' ? (
        <OAuthProviderRows
          providers={oauth.data ?? []}
          loading={oauth.isPending}
          loadError={oauth.isError ? 'Could not load sign-ins.' : null}
          onRetry={() => void oauth.refetch()}
          pendingProviderId={busy}
          onLogin={(provider, gateway) => {
            if (provider.riskLevel === 'high') {
              setRisk(provider);
              setAcknowledged(false);
            } else void login(provider, gateway);
          }}
          onLogout={(provider) =>
            void client.oauth
              .logout(provider.id)
              .then(() => cache.invalidateQueries({ queryKey: ['oauth-providers'] }))
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : 'Sign-out failed.');
              })
          }
        />
      ) : (
        <div className="grid gap-2">
          {providers.data
            .filter((provider) =>
              kind === 'local'
                ? ['ollama', 'lmstudio'].includes(provider.id)
                : !['ollama', 'lmstudio'].includes(provider.id) &&
                  provider.kind === 'api' &&
                  provider.tag !== 'subscription_oauth',
            )
            .map((provider) => (
              <div className="setting-row provider-connection-row" key={provider.id}>
                <div className="provider-connection-summary">
                  <ProviderLogo providerId={provider.id} name={provider.name} size={20} />
                  <div className="provider-connection-copy">
                    <strong>{provider.name}</strong>
                    <small>
                      {kind === 'local' &&
                      (provider.discoveryErrorClass === 'network' || provider.health === 'down')
                        ? 'Server not running or unreachable'
                        : kind === 'local' &&
                            provider.enabled &&
                            (provider.health !== 'ok' || provider.modelCount === 0)
                          ? 'Enabled; check the server and load a model'
                          : provider.enabled &&
                              ['valid', 'not_applicable'].includes(provider.keyStatus)
                            ? 'Connected'
                            : (providerDefinition(provider.id)?.releaseState ?? 'Add a connection')}
                    </small>
                  </div>
                </div>
                <UiV2.Button
                  variant="secondary"
                  size="sm"
                  disabled={providerDefinition(provider.id)?.releaseState === 'Coming soon'}
                  onClick={() => {
                    setManaging(provider);
                  }}
                >
                  {kind === 'local' ? 'Connect server' : 'Manage connection'}
                </UiV2.Button>
              </div>
            ))}
        </div>
      )}
      {kind === 'account' && (
        <div className="setting-row">
          <div>
            <strong>Use account models with Auto and Gateway</strong>
            <small>
              Subscription models consume account allowances. Enable paid backup with a positive key
              cap in the next step to authorize them.
            </small>
          </div>
          <UiV2.Switch
            aria-label="Use account models with Auto and Gateway"
            checked={settings.data?.allowSubscriptionOAuthRouting ?? false}
            disabled={!settings.data}
            onCheckedChange={(allowSubscriptionOAuthRouting) =>
              void client.settings
                .update({ allowSubscriptionOAuthRouting })
                .then(() => {
                  void cache.invalidateQueries({ queryKey: ['settings'] });
                  void cache.invalidateQueries({ queryKey: ['gateway-routing'] });
                })
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof Error ? cause.message : 'Could not update account routing.',
                  );
                })
            }
          />
        </div>
      )}
      {kind === 'local' &&
        !providers.isPending &&
        !providers.isError &&
        !providers.data.some((provider) => ['ollama', 'lmstudio'].includes(provider.id)) && (
          <p role="status">
            Local connections are not available yet.{' '}
            <UiV2.Button variant="secondary" onClick={() => void providers.refetch()}>
              Refresh connections
            </UiV2.Button>
          </p>
        )}
      {kind === 'local' && (
        <p className="v2-gateway-help">
          Start Ollama on localhost:11434 or LM Studio on localhost:1234, load a model, and enable
          its connection. The shared connection check discovers the local model list.
        </p>
      )}
      <p className="v2-gateway-help">
        Zen’s OpenCode-only free models are available in the OpenCode app. Use your own key for its
        standard API, or <code>ferry run opencode --native</code> for the real app.
      </p>
      {error && (
        <p role="alert" className="v2-gateway-error">
          {error}
        </p>
      )}
      <ProviderKeyDialog
        provider={managing}
        open={!!managing}
        onOpenChange={(open) => {
          if (!open) {
            setManaging(null);
            void cache.invalidateQueries({ queryKey: ['providers'] });
            void cache.invalidateQueries({ queryKey: ['gateway-routing'] });
          }
        }}
        showRoutingControls
      />
      <UiV2.Dialog
        open={!!risk}
        onOpenChange={(open) => {
          if (!open) setRisk(null);
        }}
      >
        <UiV2.DialogContent>
          <UiV2.DialogHeader>
            <UiV2.DialogTitle>Subscription sign-in</UiV2.DialogTitle>
            <UiV2.DialogDescription>
              {risk?.riskText ??
                'This unofficial subscription integration can carry account suspension risk.'}
            </UiV2.DialogDescription>
          </UiV2.DialogHeader>
          <label className="flex gap-3">
            <UiV2.Checkbox
              checked={acknowledged}
              onCheckedChange={(checked) => {
                setAcknowledged(checked === true);
              }}
            />
            I understand the provider’s account risk.
          </label>
          <UiV2.Button
            disabled={!acknowledged || !!busy}
            onClick={() => {
              const provider = risk;
              setRisk(null);
              if (provider) void login(provider);
            }}
          >
            Continue sign-in
          </UiV2.Button>
        </UiV2.DialogContent>
      </UiV2.Dialog>
    </div>
  );
}
