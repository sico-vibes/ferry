import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Provider } from '@ferry/shared';
import { Dialog, Pill, TextField } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useToasts } from '../state/toasts';

export function ProviderKeyDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: Provider | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const toast = useToasts((state) => state.push);
  const realProviders = window.ferryHybrid?.getRealDomains().includes('providers') ?? false;
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = async () => {
    if (!provider || !value.trim()) {
      setMessage('Enter an API key to save.');
      return;
    }
    setBusy(true);
    try {
      await client.providers.setKey(provider.id, value.trim());
      await cache.invalidateQueries({ queryKey: ['providers'] });
      setValue('');
      setMessage('Key saved. Test the connection to verify it.');
      toast({ kind: 'success', title: 'Key saved', body: `${provider.name} is ready to test.` });
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
      toast({ kind: 'info', title: 'Key removed', body: `${provider.name} has no saved key.` });
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
      onOpenChange={onOpenChange}
      title={`Manage ${provider?.name ?? 'provider'} key`}
      description={
        realProviders
          ? 'Keys are stored securely in your operating system keyring.'
          : 'Keys are stored in this local demo client.'
      }
    >
      <div className="grid gap-3">
        {provider?.signupUrl && (
          <a
            className="text-label text-link"
            href={provider.signupUrl}
            target="_blank"
            rel="noreferrer"
          >
            Get a key
          </a>
        )}
        <TextField
          label="API key"
          masked
          value={value}
          onChange={(next) => {
            setValue(next);
            setMessage('');
          }}
          placeholder="Paste provider key"
        />
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
                ? 'text-meta text-danger'
                : 'muted'
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
          <div className="button-row dialog-actions">
            <Pill disabled={busy} onClick={() => void test()}>
              {busy ? 'Testing…' : 'Test connection'}
            </Pill>
            <Pill disabled={busy} variant="blue-tint" onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save key'}
            </Pill>
            {provider?.keyStatus !== 'missing' && (
              <Pill
                disabled={busy}
                variant="outline"
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                Remove key
              </Pill>
            )}
          </div>
        )}
        <p className="text-meta text-text-3">
          {realProviders
            ? 'Keys never leave your device or appear in Ferry logs.'
            : 'Keys stay in the demo client store. Never paste a real secret into a shared demo.'}
        </p>
      </div>
    </Dialog>
  );
}
