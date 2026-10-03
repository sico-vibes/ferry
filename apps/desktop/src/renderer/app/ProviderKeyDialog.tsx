import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  const { data: providerKeys = [] } = useQuery({
    queryKey: ['provider-keys', provider?.id],
    enabled: open && Boolean(provider),
    queryFn: async () => (provider ? client.providers.listKeys(provider.id) : []),
  });
  const cache = useQueryClient();
  const realProviders = window.ferryHybrid?.getRealDomains().includes('providers') ?? false;
  const [value, setValue] = useState('');
  const [accountId, setAccountId] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [priority, setPriority] = useState('0');
  const [weight, setWeight] = useState('1');
  const [autoDisableEnabled, setAutoDisableEnabled] = useState(true);
  const [failureCount, setFailureCount] = useState('3');
  const [failureWindowMinutes, setFailureWindowMinutes] = useState('10');
  const [disableMinutes, setDisableMinutes] = useState('60');
  const [statusCodes, setStatusCodes] = useState('');
  const [keywords, setKeywords] = useState('');
  useEffect(() => {
    setPriority(
      String((provider ? settings?.routing.providerPriorities[provider.id] : undefined) ?? 0),
    );
    setWeight(String((provider ? settings?.routing.providerWeights[provider.id] : undefined) ?? 1));
    setAutoDisableEnabled(provider?.autoDisableEnabled ?? true);
    setFailureCount(String(provider?.autoDisableFailureCount ?? 3));
    setFailureWindowMinutes(String(provider?.autoDisableFailureWindowMinutes ?? 10));
    setDisableMinutes(String(provider?.autoDisableMinutes ?? 60));
    setStatusCodes((provider?.autoDisableStatusCodes ?? []).join(', '));
    setKeywords((provider?.autoDisableKeywords ?? []).join(', '));
  }, [
    provider?.id,
    provider?.autoDisableEnabled,
    provider?.autoDisableFailureCount,
    provider?.autoDisableFailureWindowMinutes,
    provider?.autoDisableMinutes,
    provider?.autoDisableStatusCodes,
    provider?.autoDisableKeywords,
    settings?.routing.providerPriorities,
    settings?.routing.providerWeights,
  ]);
  const {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Switch,
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
  const saveAutoDisablePolicy = async () => {
    if (!provider) return;
    const failureCountValue = Number(failureCount);
    const failureWindowValue = Number(failureWindowMinutes);
    const disableMinutesValue = Number(disableMinutes);
    const statusCodeValues = statusCodes.trim()
      ? statusCodes.split(',').map((value) => Number(value.trim()))
      : [];
    if (
      !Number.isInteger(failureCountValue) ||
      failureCountValue < 2 ||
      failureCountValue > 20 ||
      !Number.isInteger(failureWindowValue) ||
      failureWindowValue < 1 ||
      failureWindowValue > 1440 ||
      !Number.isInteger(disableMinutesValue) ||
      disableMinutesValue < 1 ||
      disableMinutesValue > 1440 ||
      statusCodeValues.some((value) => !Number.isInteger(value) || value < 100 || value > 599)
    ) {
      setMessage('Check the failure count, time windows, and HTTP status codes.');
      return;
    }
    setBusy(true);
    try {
      await client.providers.setAutoDisablePolicy(provider.id, {
        enabled: autoDisableEnabled,
        failureCount: failureCountValue,
        failureWindowMinutes: failureWindowValue,
        statusCodes: statusCodeValues,
        keywords: keywords
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        disableMinutes: disableMinutesValue,
      });
      await cache.invalidateQueries({ queryKey: ['providers'] });
      setMessage('Key health policy saved.');
    } catch {
      setMessage('Key health policy could not be saved.');
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
      if (providerKeys.length) {
        await client.providers.addKey(
          provider.id,
          keyLabel.trim() || `Key ${String(providerKeys.length + 1)}`,
          secret,
        );
      } else {
        await client.providers.setKey(provider.id, secret);
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['providers'] }),
        cache.invalidateQueries({ queryKey: ['provider-keys', provider.id] }),
      ]);
      setValue('');
      setAccountId('');
      setKeyLabel('');
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
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['providers'] }),
        cache.invalidateQueries({ queryKey: ['provider-keys', provider.id] }),
      ]);
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
  const changeKeyEnabled = async (keyId: string, enabled: boolean) => {
    if (!provider) return;
    await client.providers.setKeyEnabled(provider.id, keyId, enabled);
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['provider-keys', provider.id] }),
      cache.invalidateQueries({ queryKey: ['providers'] }),
    ]);
  };
  const moveKeyUp = async (index: number) => {
    if (!provider || index < 1) return;
    const ids = providerKeys.map((entry) => entry.id);
    const previous = ids[index - 1];
    const current = ids[index];
    if (previous === undefined || current === undefined) return;
    ids[index - 1] = current;
    ids[index] = previous;
    await client.providers.reorderKeys(provider.id, ids);
    await cache.invalidateQueries({ queryKey: ['provider-keys', provider.id] });
  };
  const removeKeyEntry = async (keyId: string) => {
    if (!provider) return;
    await client.providers.removeKeyEntry(provider.id, keyId);
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['provider-keys', provider.id] }),
      cache.invalidateQueries({ queryKey: ['providers'] }),
    ]);
  };
  return (
    <Dialog
      open={open && Boolean(provider)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setValue('');
          setAccountId('');
          setKeyLabel('');
          setMessage('');
          setConfirmRemove(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        aria-describedby="provider-key-description"
        className="h-[min(90dvh,48rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="mr-auto grid gap-2">
              <DialogTitle>Manage {provider?.name ?? 'provider'} key</DialogTitle>
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
        <div className="min-h-0 overflow-y-auto pr-2">
          <div className="grid gap-4">
            {providerKeys.length > 0 && (
              <section className="grid gap-2" aria-label="Saved provider keys">
                <h3 className="text-ui-label">Saved keys</h3>
                {providerKeys.map((item, index) => (
                  <div
                    className="flex items-center gap-2 rounded-lg border border-border p-3"
                    key={item.id}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 rounded-full ${item.status === 'ok' ? 'bg-success' : item.status === 'rate_limited' ? 'bg-warning' : item.status === 'invalid' ? 'bg-destructive' : 'bg-muted-foreground'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-ui-label">
                        {item.label} (ending {item.lastFour})
                      </span>
                      <span className="text-meta text-text-3">
                        {item.status.replace('_', ' ')}
                        <span className="block">
                          {String(item.usageToday.requests)} requests /{' '}
                          {String(item.usageToday.tokens)} tokens today
                        </span>
                        {item.lastError && <span className="block">{item.lastError}</span>}
                      </span>
                    </span>
                    <Button
                      aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.label}`}
                      onClick={() => {
                        void changeKeyEnabled(item.id, !item.enabled);
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {item.enabled ? 'On' : 'Off'}
                    </Button>
                    <Button
                      aria-label={`Move ${item.label} up`}
                      disabled={index === 0}
                      onClick={() => {
                        void moveKeyUp(index);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      Up
                    </Button>
                    <Button
                      aria-label={`Remove ${item.label}`}
                      onClick={() => {
                        void removeKeyEntry(item.id);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </section>
            )}
            {showRoutingControls && (
              <section className="grid gap-3" aria-label="Provider routing">
                <h3 className="text-ui-label">Routing</h3>
                <p className="text-meta text-text-3">
                  Higher priority is tried first. Weight changes the share among near-equal
                  providers at that priority.
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
            <section className="grid gap-3" aria-label="Key health policy">
              <h3 className="text-ui-label">Automatic key recovery</h3>
              <label className="flex items-center gap-2 text-ui-label">
                <Switch checked={autoDisableEnabled} onCheckedChange={setAutoDisableEnabled} />
                Disable unhealthy keys automatically
              </label>
              <p className="text-meta text-text-3">
                Authentication failures disable a key. Repeated failures or matching status codes
                and messages pause it temporarily; hourly probes can restore it.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-ui-label">
                  Failures
                  <Input
                    aria-label="Failure count"
                    min={2}
                    max={20}
                    onChange={(event) => {
                      setFailureCount(event.target.value);
                    }}
                    type="number"
                    value={failureCount}
                  />
                </label>
                <label className="grid gap-1 text-ui-label">
                  Window (minutes)
                  <Input
                    aria-label="Failure window minutes"
                    min={1}
                    max={1440}
                    onChange={(event) => {
                      setFailureWindowMinutes(event.target.value);
                    }}
                    type="number"
                    value={failureWindowMinutes}
                  />
                </label>
                <label className="grid gap-1 text-ui-label">
                  Pause (minutes)
                  <Input
                    aria-label="Disable duration minutes"
                    min={1}
                    max={1440}
                    onChange={(event) => {
                      setDisableMinutes(event.target.value);
                    }}
                    type="number"
                    value={disableMinutes}
                  />
                </label>
                <label className="grid gap-1 text-ui-label">
                  HTTP status codes
                  <Input
                    aria-label="Disable status codes"
                    onChange={(event) => {
                      setStatusCodes(event.target.value);
                    }}
                    placeholder="500, 503"
                    value={statusCodes}
                  />
                </label>
              </div>
              <label className="grid gap-1 text-ui-label">
                Error message keywords
                <Input
                  aria-label="Disable keywords"
                  onChange={(event) => {
                    setKeywords(event.target.value);
                  }}
                  placeholder="overloaded, account suspended"
                  value={keywords}
                />
              </label>
              <Button
                disabled={busy}
                onClick={() => void saveAutoDisablePolicy()}
                variant="secondary"
              >
                Save key health policy
              </Button>
            </section>
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
            {providerKeys.length > 0 && (
              <label className="grid gap-2 text-ui-label">
                Key label
                <Input
                  aria-label="Key label"
                  onChange={(event) => {
                    setKeyLabel(event.target.value);
                  }}
                  placeholder={`Key ${String(providerKeys.length + 1)}`}
                  value={keyLabel}
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
                <Button
                  onClick={() => {
                    setConfirmRemove(false);
                  }}
                  variant="secondary"
                >
                  Cancel
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void remove();
                  }}
                  variant="destructive"
                >
                  {busy ? 'Removing…' : 'Remove key'}
                </Button>
              </p>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button disabled={busy} onClick={() => void test()} variant="secondary">
                  {busy ? 'Testing…' : 'Test connection'}
                </Button>
                <Button disabled={busy} onClick={() => void save()}>
                  {busy ? 'Saving…' : providerKeys.length ? 'Add key' : 'Save key'}
                </Button>
                {providerKeys.length === 0 && provider?.keyStatus !== 'missing' && (
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
