import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Provider } from '@ferry/shared';
import { ArrowDown, ArrowUp, Trash2, X } from 'lucide-react';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useSettings } from '../data/queries';
import { ProviderStatusBadge } from './ProviderStatusBadge';
import { ConfirmDialog } from './ConfirmDialog';
import { usesRealDomain } from '../data/realDomains';

const numberFormat = new Intl.NumberFormat();

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
  const realProviders = usesRealDomain('providers');
  const [value, setValue] = useState('');
  const [accountId, setAccountId] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRemoveKeyId, setConfirmRemoveKeyId] = useState<string | null>(null);
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
  const moveKeyDown = async (index: number) => {
    if (!provider || index >= providerKeys.length - 1) return;
    const ids = providerKeys.map((entry) => entry.id);
    const current = ids[index];
    const next = ids[index + 1];
    if (current === undefined || next === undefined) return;
    ids[index] = next;
    ids[index + 1] = current;
    await client.providers.reorderKeys(provider.id, ids);
    await cache.invalidateQueries({ queryKey: ['provider-keys', provider.id] });
  };
  const removeKeyEntry = async (keyId: string) => {
    if (!provider) return;
    setBusy(true);
    try {
      await client.providers.removeKeyEntry(provider.id, keyId);
      setConfirmRemoveKeyId(null);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['provider-keys', provider.id] }),
        cache.invalidateQueries({ queryKey: ['providers'] }),
      ]);
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
          setKeyLabel('');
          setMessage('');
          setConfirmRemove(false);
          setConfirmRemoveKeyId(null);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        aria-describedby="provider-key-description"
        className="h-[min(90dvh,48rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="mr-auto grid gap-2">
              <DialogTitle>Manage {provider?.name ?? 'provider'} key</DialogTitle>
              <DialogDescription id="provider-key-description">
                {showRoutingControls
                  ? `Manage ${provider?.name ?? 'provider'} keys. Ferry rotates through enabled keys in this order.`
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
            <p className="text-meta text-text-3">
              Use keys you own under one provider account, such as separate project keys. Pooling
              accounts to multiply free tiers may violate provider terms; Ferry does not support it.
            </p>
            {providerKeys.length > 0 && (
              <section className="grid gap-2" aria-label="Saved provider keys">
                <h3 className="text-ui-label">Saved keys</h3>
                {providerKeys.map((item, index) => (
                  <div
                    className="grid gap-2 border-b border-border py-3 last:border-b-0"
                    key={item.id}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                      <div className="grid min-w-0 flex-1 gap-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="text-ui-label">
                            {item.label} (ending {item.lastFour})
                          </span>
                          <ProviderStatusBadge
                            status={item.status}
                            cooldownUntil={item.cooldownUntil}
                            enabled={item.enabled}
                          />
                        </div>
                        <p className="text-meta text-text-3">
                          {numberFormat.format(item.usageToday.requests)} requests /{' '}
                          {numberFormat.format(item.usageToday.tokens)} tokens today
                        </p>
                        {item.lastError && (
                          <p className="text-meta text-text-3">{item.lastError}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-ui-label">Enabled</span>
                        <Switch
                          aria-label={`Enable ${item.label}`}
                          checked={item.enabled}
                          disabled={busy}
                          onCheckedChange={(enabled) => {
                            void changeKeyEnabled(item.id, enabled);
                          }}
                        />
                      </div>
                      <UiV2.TooltipProvider>
                        <UiV2.Tooltip>
                          <UiV2.TooltipTrigger asChild>
                            <Button
                              aria-label={`Move up ${item.label}`}
                              disabled={busy || index === 0}
                              onClick={() => void moveKeyUp(index)}
                              size="icon"
                              variant="ghost"
                            >
                              <ArrowUp aria-hidden="true" size={16} strokeWidth={1.75} />
                            </Button>
                          </UiV2.TooltipTrigger>
                          <UiV2.TooltipContent>Move up</UiV2.TooltipContent>
                        </UiV2.Tooltip>
                      </UiV2.TooltipProvider>
                      <UiV2.TooltipProvider>
                        <UiV2.Tooltip>
                          <UiV2.TooltipTrigger asChild>
                            <Button
                              aria-label={`Move down ${item.label}`}
                              disabled={busy || index === providerKeys.length - 1}
                              onClick={() => void moveKeyDown(index)}
                              size="icon"
                              variant="ghost"
                            >
                              <ArrowDown aria-hidden="true" size={16} strokeWidth={1.75} />
                            </Button>
                          </UiV2.TooltipTrigger>
                          <UiV2.TooltipContent>Move down</UiV2.TooltipContent>
                        </UiV2.Tooltip>
                      </UiV2.TooltipProvider>
                      <UiV2.TooltipProvider>
                        <UiV2.Tooltip>
                          <UiV2.TooltipTrigger asChild>
                            <Button
                              aria-label={`Remove ${item.label}`}
                              disabled={busy}
                              onClick={() => {
                                setConfirmRemoveKeyId(item.id);
                              }}
                              size="icon"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 aria-hidden="true" size={16} strokeWidth={1.75} />
                            </Button>
                          </UiV2.TooltipTrigger>
                          <UiV2.TooltipContent>Remove key</UiV2.TooltipContent>
                        </UiV2.Tooltip>
                      </UiV2.TooltipProvider>
                    </div>
                  </div>
                ))}
              </section>
            )}
            {showRoutingControls && (
              <section className="grid gap-3" aria-label="Provider routing">
                <h3 className="text-ui-label">Routing</h3>
                <p className="text-meta text-text-3">
                  Higher priority is tried first; weight sets share within that tier.
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
            <p className="text-meta text-text-3">
              {realProviders
                ? 'Keys never leave your device or appear in Ferry logs.'
                : 'Keys stay in the demo client store. Never paste a real secret into a shared demo.'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
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
          <Button disabled={busy} onClick={() => void test()} variant="secondary">
            {busy ? 'Testing…' : 'Test connection'}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : providerKeys.length ? 'Add key' : 'Save key'}
          </Button>
        </div>
      </DialogContent>
      <ConfirmDialog
        open={confirmRemoveKeyId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemoveKeyId(null);
        }}
        title="Remove key entry?"
        description={`Remove ${providerKeys.find((item) => item.id === confirmRemoveKeyId)?.label ?? 'this key'} from Ferry.`}
        confirmLabel="Remove key"
        destructive
        onConfirm={() => {
          if (confirmRemoveKeyId) void removeKeyEntry(confirmRemoveKeyId);
          setConfirmRemoveKeyId(null);
        }}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove saved key?"
        description={`Remove the saved key for ${provider?.name ?? 'this provider'}.`}
        confirmLabel={busy ? 'Removing…' : 'Remove key'}
        destructive
        onConfirm={() => {
          void remove();
        }}
      />
    </Dialog>
  );
}
