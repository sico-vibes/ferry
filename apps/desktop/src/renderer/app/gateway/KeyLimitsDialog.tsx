import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listAllModels } from '@ferry/client';
import { SegmentedControl, Select, Switch, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { ModelMultiPicker } from './ModelMultiPicker';
import { gatewayRoutingMode, NO_PROFILE, type GatewayRoutingMode } from './modelSelection';
import type { GatewayKeyRow } from './gatewayView';
export function KeyLimitsDialog({
  gatewayKey,
  profiles,
  onClose,
}: {
  gatewayKey: GatewayKeyRow | null;
  profiles: { value: string; label: string }[];
  onClose: () => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => listAllModels(client),
  });
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  // Profile used when switching back from "Pick models" to "Use a profile".
  const [lastProfile, setLastProfile] = useState('auto-free');
  const [draft, setDraft] = useState({
    profile: 'auto-free',
    allowedModels: [] as string[],
    rateLimit: '',
    tokenLimitPerMinute: '',
    tokenLimitPerDay: '',
    concurrencyLimit: '',
    paidBackup: false,
    budgetUsd: '',
    compressToolResults: false,
    terseSystemPrompt: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [assignedClient, setAssignedClient] = useState('');
  useEffect(() => {
    if (!gatewayKey) return;
    const text = (value: number | null) => (value === null ? '' : String(value));
    setDraft({
      profile: gatewayKey.profile,
      allowedModels: [...gatewayKey.allowedModels],
      rateLimit: text(gatewayKey.rateLimit),
      tokenLimitPerMinute: text(gatewayKey.tokenLimitPerMinute),
      tokenLimitPerDay: text(gatewayKey.tokenLimitPerDay),
      concurrencyLimit: text(gatewayKey.concurrencyLimit),
      paidBackup: gatewayKey.paidBackup ?? false,
      budgetUsd: text(gatewayKey.budgetUsd ?? null),
      compressToolResults: gatewayKey.compressToolResults,
      terseSystemPrompt: gatewayKey.terseSystemPrompt,
    });
    if (gatewayKey.profile !== NO_PROFILE) setLastProfile(gatewayKey.profile);
    setError('');
    setAssignedClient(gatewayKey.client ?? '');
  }, [gatewayKey]);
  const routingMode = gatewayRoutingMode(draft.profile);
  const limit = (
    field: 'rateLimit' | 'tokenLimitPerMinute' | 'tokenLimitPerDay' | 'concurrencyLimit',
    label: string,
  ) => (
    <label className="v2-gateway-field">
      <span>{label}</span>
      <UiV2.Input
        inputMode="numeric"
        onChange={(event) => {
          setDraft((current) => ({ ...current, [field]: event.target.value }));
        }}
        placeholder={field === 'concurrencyLimit' ? 'Default: 4' : 'Unlimited'}
        value={draft[field]}
      />
    </label>
  );
  const save = async () => {
    if (!gatewayKey || busy) return;
    const numberOrNull = (value: string) => (value.trim() ? Number(value) : null);
    const limits = {
      rateLimit: numberOrNull(draft.rateLimit),
      tokenLimitPerMinute: numberOrNull(draft.tokenLimitPerMinute),
      tokenLimitPerDay: numberOrNull(draft.tokenLimitPerDay),
      concurrencyLimit: numberOrNull(draft.concurrencyLimit),
    };
    if (
      Object.values(limits).some(
        (value) => value !== null && (!Number.isInteger(value) || value < 1),
      )
    ) {
      setError('Limits must be whole numbers of at least 1, or empty for unlimited.');
      return;
    }
    const budgetUsd = numberOrNull(draft.budgetUsd);
    if (draft.paidBackup && (budgetUsd === null || !Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
      setError('Paid backup requires a positive monthly spending limit.');
      return;
    }
    try {
      setBusy(true);
      await client.gateway.updateKey({
        id: gatewayKey.id,
        patch: {
          client: assignedClient.trim(),
          ...limits,
          paidBackup: draft.paidBackup,
          budgetUsd,
          profile: draft.profile,
          allowedModels: draft.allowedModels,
          compressToolResults: draft.compressToolResults,
          terseSystemPrompt: draft.terseSystemPrompt,
        },
      });
      await cache.invalidateQueries({ queryKey: ['gateway-keys'] });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this key. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <UiV2.Dialog
      open={gatewayKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <UiV2.DialogContent className="v2-gateway-dialog">
        <UiV2.DialogHeader>
          <UiV2.DialogTitle>{gatewayKey?.name} settings</UiV2.DialogTitle>
          <UiV2.DialogDescription>
            Routing and limits for requests made with this key.
          </UiV2.DialogDescription>
        </UiV2.DialogHeader>
        <div className="v2-gateway-form">
          <label className="v2-gateway-field">
            <span>Assigned client</span>
            <UiV2.Input
              value={assignedClient}
              onChange={(event) => {
                setAssignedClient(event.target.value);
              }}
              maxLength={80}
            />
          </label>
          <p className="v2-gateway-help">
            {draft.paidBackup ? `Paid backup up to $${draft.budgetUsd}/month.` : 'Free only.'}{' '}
            {draft.allowedModels.length
              ? `${String(draft.allowedModels.length)} allowed models.`
              : 'Preset models.'}{' '}
            API clients preserve fidelity unless you explicitly enable compression below.
          </p>
          <details>
            <summary>Advanced routing and limits</summary>
            <div className="grid gap-4 pt-3">
              <div className="v2-gateway-field">
                <span>Routing</span>
                <SegmentedControl
                  label="Routing"
                  value={routingMode}
                  onValueChange={(value) => {
                    const mode = value as GatewayRoutingMode;
                    setDraft((current) => ({
                      ...current,
                      profile: mode === 'models' ? NO_PROFILE : lastProfile,
                    }));
                  }}
                  options={[
                    { value: 'profile', label: 'Use a profile' },
                    { value: 'models', label: 'Pick models' },
                  ]}
                />
                <small className="v2-gateway-help">
                  {routingMode === 'models'
                    ? 'No profile. Requests go to the models below, tried in this order when one is rate limited or fails.'
                    : 'The profile picks a model for each request. Optionally limit it to the models below.'}
                </small>
              </div>
              {routingMode === 'profile' ? (
                <Select
                  label="Routing profile"
                  onValueChange={(profile) => {
                    setLastProfile(profile);
                    setDraft((current) => ({ ...current, profile }));
                  }}
                  options={profiles.filter((profile) => profile.value !== NO_PROFILE)}
                  value={draft.profile}
                />
              ) : null}
              <div className="v2-gateway-field">
                <span>{routingMode === 'models' ? 'Models' : 'Limit to models (optional)'}</span>
                <ModelMultiPicker
                  emptyLabel={
                    routingMode === 'models'
                      ? 'No models picked yet: every connected model is allowed.'
                      : 'No limit: every model the profile allows.'
                  }
                  models={models}
                  providers={providers}
                  value={draft.allowedModels}
                  onChange={(allowedModels) => {
                    setDraft((current) => ({ ...current, allowedModels }));
                  }}
                />
              </div>
              <div className="v2-gateway-form-grid">
                {limit('rateLimit', 'Requests per minute')}
                {limit('concurrencyLimit', 'Concurrent requests')}
                {limit('tokenLimitPerMinute', 'Tokens per minute')}
                {limit('tokenLimitPerDay', 'Tokens per day')}
                <label className="v2-gateway-field">
                  <span>Monthly spending limit (USD)</span>
                  <UiV2.Input
                    inputMode="decimal"
                    value={draft.budgetUsd}
                    placeholder="Required for paid backup"
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, budgetUsd: event.target.value }));
                    }}
                  />
                </label>
                <label className="v2-gateway-field">
                  <span>Allow paid backup</span>
                  <Switch
                    checked={draft.paidBackup}
                    onCheckedChange={(paidBackup) => {
                      setDraft((current) => ({ ...current, paidBackup }));
                    }}
                  />
                </label>
                <p className="text-ui-meta text-muted-foreground">
                  Free only by default. Paid calls need a paid-capable profile and this key’s
                  positive limit. Profile and global limits also apply.
                </p>
              </div>
              <label className="v2-gateway-toggle">
                <span>
                  <strong>Compress tool results</strong>
                  <small>Shorten long tool output before it reaches the model.</small>
                </span>
                <UiV2.Switch
                  aria-label="Compress tool results"
                  checked={draft.compressToolResults}
                  onCheckedChange={(compressToolResults) => {
                    setDraft((current) => ({ ...current, compressToolResults }));
                  }}
                />
              </label>
              <label className="v2-gateway-toggle">
                <span>
                  <strong>Terse system prompt</strong>
                  <small>Ask the model for shorter answers to save tokens.</small>
                </span>
                <UiV2.Switch
                  aria-label="Terse system prompt"
                  checked={draft.terseSystemPrompt}
                  onCheckedChange={(terseSystemPrompt) => {
                    setDraft((current) => ({ ...current, terseSystemPrompt }));
                  }}
                />
              </label>
              {error && (
                <p className="v2-gateway-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </details>
        </div>
        <div className="v2-gateway-dialog-actions">
          <UiV2.Button onClick={onClose} variant="secondary">
            Cancel
          </UiV2.Button>
          <UiV2.Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save key settings'}
          </UiV2.Button>
        </div>
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}
