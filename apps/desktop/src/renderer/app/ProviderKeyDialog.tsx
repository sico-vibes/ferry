import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Provider } from '@ferry/shared';
import { X } from 'lucide-react';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useSettings } from '../data/queries';

export function ProviderKeyDialog({
  provider,
  open,
  onOpenChange,
  showRoutingControls = false,
}: {
  provider: Provider | null;
  showRoutingControls?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useFerryClient();
  const { data: settings } = useSettings();
  const cache = useQueryClient();
  const realProviders = window.ferryHybrid?.getRealDomains().includes('providers') ?? false;
  const [value, setValue] = useState('');
  const [accountId, setAccountId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [priority, setPriority] = useState('0');
  const [weight, setWeight] = useState('1');
  useEffect(() => {
    setPriority(
      String((provider ? settings?.routing.providerPriorities[provider.id] : undefined) ?? 0),
    );
    setWeight(String((provider ? settings?.routing.providerWeights[provider.id] : undefined) ?? 1));
  }, [provider?.id, settings?.routing.providerPriorities, settings?.routing.providerWeights]);
  const {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
  } = UiV2;
  const saveRouting = async () => {
    if (!provider || !settings) return;
    const priorityValue = Number(priority);
    const weightValue = Number(weight);
    if (!Number.isInteger(priorityValue) || priorityValue < -100 || priorityValue > 100) {
      setMessage('Priority must be a whole number from -100 to 100.');
      return;
    }
    if (!Number.isFinite(weightValue) || weightValue < 0.01 || weightValue > 1000) {
      setMessage('Weight must be between 0.01 and 1000.');
      return;
    }
    setBusy(true);
    try {
      const providerPriorities = { ...settings.routing.providerPriorities };
      const providerWeights = { ...settings.routing.providerWeights };
      providerPriorities[provider.id] = priorityValue;
      providerWeights[provider.id] = weightValue;
      await client.settings.update({
        routing: { ...settings.routing, providerPriorities, providerWeights },
      });
      await cache.invalidateQueries({ queryKey: ['settings'] });
      setMessage('Routing preference saved.');
    } catch {
      setMessage('Routing preference could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (provider?.id === 'cloudflare-workers-ai' && !accountId.trim()) {
      setMessage('Enter the Cloudflare account ID.');
      return;
    }
    if (!provider || !value.trim()) {
      setMessage('Enter an API key to save.');
      return;
    }
    setBusy(true);
    try {
      const secret =
        provider.id === 'cloudflare-workers-ai'
          ? JSON.stringify({ accountId: accountId.trim(), apiKey: value.trim() })
          : value.trim();
      await client.providers.setKey(provider.id, secret);
      await cache.invalidateQueries({ queryKey: ['providers'] });
      setValue('');
      setAccountId('');
      setMessage('Key saved. Test the connection to verify it.');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Key could not be saved: ${error.message}`
          : 'Key could not be saved. Check the value and try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    if (!provider) return;
    setBusy(true);
    setMessage('Testing connection…');
    try {
      const result = await client.providers.probe(provider.id);
      setMessage(
        result.ok
          ? `Connected in ${result.latencyMs === null ? 'CLI' : `${String(result.latencyMs)} ms`}. Next: select this provider in a profile.`
          : `Connection failed: ${result.message}. Check the key and try again.`,
      );
      await cache.invalidateQueries({ queryKey: ['providers'] });
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Connection test failed: ${error.message}. Check the key and try again.`
          : 'Connection test failed. Check the key and try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!provider) return;
    setBusy(true);
    try {
      await client.providers.removeKey(provider.id);
      await cache.invalidateQueries({ queryKey: ['providers'] });
      setConfirmRemove(false);
      setMessage('Key removed.');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Key could not be removed: ${error.message}`
          : 'Key could not be removed. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open && Boolean(provider)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setValue('');
          setAccountId('');
          setMessage('');
          setConfirmRemove(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent aria-describedby="provider-key-description">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="mr-auto grid gap-2">
              <DialogTitle>Manage {provider?.name ?? 'provider'}</DialogTitle>
              <DialogDescription id="provider-key-description">
                {showRoutingControls
                  ? 'Set the provider routing tier and relative share, then manage its key.'
                  : realProviders
                    ? 'Keys are stored securely in your operating system keyring.'
                    : 'Keys are stored in this local demo client.'}
              </DialogDescription>
            </div>
            <DialogClose aria-label="Close dialog">
              <X aria-hidden="true" />
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="grid gap-4">
          {showRoutingControls && (
            <section className="grid gap-3" aria-label="Provider routing">
              <h3 className="text-ui-label">Routing</h3>
              <p className="text-meta text-text-3">
                Higher priority is tried first. Weight changes the share among near-equal providers
                at that priority.
              </p>
              <label className="grid gap-2 text-ui-label">
                Priority
                <Input
                  aria-label="Priority"
                  type="number"
                  min={-100}
                  max={100}
                  step={1}
                  value={priority}
                  onChange={(event) => {
                    setPriority(event.target.value);
                  }}
                />
              </label>
              <label className="grid gap-2 text-ui-label">
                Weight
                <Input
                  aria-label="Weight"
                  type="number"
                  min={0.01}
                  max={1000}
                  step={0.1}
                  value={weight}
                  onChange={(event) => {
                    setWeight(event.target.value);
                  }}
                />
              </label>
              <Button
                disabled={busy || !settings}
                onClick={() => void saveRouting()}
                variant="secondary"
              >
                Save routing
              </Button>
            </section>
          )}
          {provider?.signupUrl && (
            <a
              className="text-label text-primary"
              href={provider.signupUrl}
              target="_blank"
              rel="noreferrer"
            >
              Get a key
            </a>
          )}
          {provider?.id === 'cloudflare-workers-ai' && (
            <label className="grid gap-2 text-ui-label">
              Cloudflare account ID
              <Input
                autoComplete="off"
                aria-label="Cloudflare account ID"
                onChange={(event) => {
                  setAccountId(event.target.value);
                  setMessage('');
                }}
                placeholder="Account ID"
                value={accountId}
              />
            </label>
          )}
          <label className="grid gap-2 text-ui-label">
            {provider?.id === 'cloudflare-workers-ai' ? 'Cloudflare API token' : 'API key'}
            <Input
              aria-label={
                provider?.id === 'cloudflare-workers-ai' ? 'Cloudflare API token' : 'API key'
              }
              autoComplete="new-password"
              onChange={(event) => {
                setValue(event.target.value);
                setMessage('');
              }}
              placeholder="Paste provider key"
              type="password"
              value={value}
            />
          </label>
          {message && (
            <p
              role={
                message.includes('failed') ||
                message.includes('could not') ||
                message.includes('Enter')
                  ? 'alert'
                  : 'status'
              }
              className={
                message.includes('failed') ||
                message.includes('could not') ||
                message.includes('Enter')
                  ? 'text-ui-meta text-destructive'
                  : 'text-ui-meta text-muted-foreground'
              }
            >
              {message}
            </p>
          )}
          {confirmRemove ? (
            <p role="alert">
              Remove the saved key for {provider?.name}?{' '}
              <button
                type="button"
                onClick={() => {
                  setConfirmRemove(false);
                }}
              >
                Cancel
              </button>{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void remove();
                }}
              >
                {busy ? 'Removing…' : 'Remove key'}
              </button>
            </p>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={busy} onClick={() => void test()} variant="secondary">
                {busy ? 'Testing…' : 'Test connection'}
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save key'}
              </Button>
              {provider?.keyStatus !== 'missing' && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setConfirmRemove(true);
                  }}
                  variant="ghost"
                >
                  Remove key
                </Button>
              )}
            </div>
          )}
          <p className="text-meta text-text-3">
            {realProviders
              ? 'Keys never leave your device or appear in Ferry logs.'
              : 'Keys stay in the demo client store. Never paste a real secret into a shared demo.'}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
