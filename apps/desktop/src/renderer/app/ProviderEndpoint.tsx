import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UiV2 } from '@ferry/ui';
import { SettingsSchema, type Provider } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { useSettings } from '../data/queries';

export function ProviderEndpoint({ provider }: { provider: Provider }) {
  const client = useFerryClient(),
    cache = useQueryClient();
  const { data: settings } = useSettings();
  const endpoints =
    SettingsSchema.shape.providerEndpoints.safeParse(settings?.providerEndpoints).data ?? {};
  const saved = endpoints[provider.id] ?? '';
  const [url, setUrl] = useState(saved);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    setUrl(saved);
    setMessage('');
  }, [saved, provider.id]);
  const local = ['ollama', 'lmstudio'].includes(provider.id);
  async function save() {
    if (!settings || lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    try {
      const endpoints = { ...settings.providerEndpoints };
      if (url.trim()) endpoints[provider.id] = url.trim().replace(/\/$/, '');
      else Reflect.deleteProperty(endpoints, provider.id);
      SettingsSchema.shape.providerEndpoints.parse(endpoints);
      await client.settings.update({ providerEndpoints: endpoints });
      await cache.invalidateQueries({ queryKey: ['settings'] });
      await cache.invalidateQueries({ queryKey: ['providers'] });
      await cache.invalidateQueries({ queryKey: ['models'] });
      await cache.invalidateQueries({ queryKey: ['provider-check'] });
      setMessage(
        'Endpoint saved. Previous discovery evidence was cleared; check this connection again.',
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Endpoint could not be saved. Retry.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-3" aria-label="Provider endpoint">
      <h3>Endpoint</h3>
      <p className="text-ui-meta text-muted-foreground">
        {local
          ? 'Start the local server and load a model. An API key is optional when your server requires authentication.'
          : 'Use the base URL from your provider’s regional or OpenAI-compatible API documentation. Keys remain in the credential store.'}
      </p>
      <UiV2.Input
        aria-label="Provider base URL"
        type="url"
        value={url}
        placeholder={
          provider.id === 'ollama'
            ? 'http://127.0.0.1:11434/v1'
            : provider.id === 'lmstudio'
              ? 'http://127.0.0.1:1234/v1'
              : 'https://your-server.example/v1'
        }
        onChange={(event) => {
          setUrl(event.target.value);
        }}
      />
      <p className="text-ui-meta text-muted-foreground">
        Empty uses the provider template. Custom APIs require a base URL. Models with unknown paid
        prices cannot enter Auto.
      </p>
      <div>
        <UiV2.Button
          variant="secondary"
          disabled={busy || !settings || url === saved}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save endpoint'}
        </UiV2.Button>
      </div>
      {message && (
        <p role="status" className="text-ui-meta">
          {message}
        </p>
      )}
    </section>
  );
}
