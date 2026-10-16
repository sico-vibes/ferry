import { useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, GripVertical, Search } from 'lucide-react';
import {
  isOpenCodeAppModel,
  OPTIMIZATION_PRESETS,
  optimizationPreset,
  ProfileSchema,
} from '@ferry/shared';
import type { ModelInfo, ModelRef, Profile, Provider } from '@ferry/shared';
import { ProviderLogo, Select, UiV2 } from '@ferry/ui';
import { providerAllowed, toggleProvider } from './profileDraft';

import { CliModelDefaults } from './CliModelDefaults';

const steps = ['Purpose', 'Providers', 'Spending', 'Models', 'Optimization', 'Review'];
const explanations = [
  'Give this profile a name and choose what Ferry should prioritize.',
  'Choose the connections Ferry may use. You can keep all eligible free providers or pick your own.',
  'Stay free by default. Paid access requires limits and the existing request authorization rules.',
  'Let Auto choose suitable models, or select a smaller set and arrange their fallback order.',
  'Preserve full detail, or trim noisy tool output while keeping the full output recoverable.',
  'Check your choices before saving. Saving never sends a model request or spends your balance.',
];

export function ProfileSetupWizard({
  initial,
  providers,
  models,
  onSave,
  onCancel,
}: {
  initial: Profile;
  providers: Provider[];
  models: ModelInfo[];
  onSave: (profile: Profile) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ModelRef[]>(initial.allowedModelRefs ?? []);
  const [manual, setManual] = useState(initial.allowedModelRefs !== undefined);
  const [dragged, setDragged] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const connected = providers.filter(
    (p) => p.enabled && !['invalid', 'missing'].includes(p.keyStatus),
  );
  const available = models.filter(
    (m) =>
      !isOpenCodeAppModel(m) &&
      (draft.paidAllowed ||
        m.free ||
        (draft.allowSubscriptionCli && m.cliCapabilities?.billing === 'included_subscription')) &&
      connected.some((p) => p.id === m.providerId && providerAllowed(draft.allowedProviders, p)),
  );
  const visible = available.filter((m) =>
    `${m.name} ${m.providerId} ${m.ref}`.toLowerCase().includes(query.toLowerCase()),
  );
  const usableSelected = selected.filter((ref) => available.some((m) => m.ref === ref));
  const patch = (value: Partial<Profile>) => {
    setError('');
    setDraft((current) => ({ ...current, ...value }));
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= selected.length || from === to) return;
    const next = [...selected],
      ref = next.splice(from, 1)[0];
    if (ref) {
      next.splice(to, 0, ref);
      setSelected(next);
    }
  };
  const validation =
    step === 0 && !draft.name.trim()
      ? 'Give this profile a name.'
      : step === 1 && Array.isArray(draft.allowedProviders) && !draft.allowedProviders.length
        ? 'Choose at least one provider.'
        : step >= 3 && manual && !usableSelected.length
          ? 'Select at least one available model, or use Auto.'
          : step >= 2 &&
              draft.paidAllowed &&
              !(typeof draft.caps.monthlyUsd === 'number' && draft.caps.monthlyUsd > 0)
            ? 'Set a positive monthly spending limit before enabling paid models.'
            : '';
  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const candidate = { ...draft, name: draft.name.trim() };
      if (manual) {
        candidate.allowedModelRefs = usableSelected;
        const tiers = [
          ...new Set(
            models.filter((model) => usableSelected.includes(model.ref)).map((model) => model.tier),
          ),
        ];
        candidate.tierByStep = { ...candidate.tierByStep };
        for (const kind of Object.keys(candidate.tierByStep) as (keyof Profile['tierByStep'])[])
          candidate.tierByStep[kind] = [...tiers];
        candidate.roles = { ...candidate.roles, enabled: false };
        candidate.fallbackChain = usableSelected.flatMap((ref) => {
          const model = models.find((m) => m.ref === ref);
          return model
            ? [{ provider: model.providerId, patterns: [ref.slice(model.providerId.length + 1)] }]
            : [];
        });
      } else {
        delete candidate.allowedModelRefs;
        if (initial.allowedModelRefs !== undefined) delete candidate.fallbackChain;
      }
      await onSave(ProfileSchema.parse(candidate));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this profile. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <UiV2.Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <UiV2.DialogContent className="profile-setup-dialog">
        <UiV2.DialogHeader>
          <UiV2.DialogTitle>
            {saved
              ? 'Profile saved'
              : initial.builtin
                ? 'Customize a profile'
                : 'Set up your profile'}
          </UiV2.DialogTitle>
          <UiV2.DialogDescription>
            {saved
              ? `${draft.name} is ready. Choose it from the model menu or assign it to a Gateway key.`
              : 'A few focused choices, one step at a time. Your current profile stays active until you apply this one.'}
          </UiV2.DialogDescription>
        </UiV2.DialogHeader>
        {saved ? (
          <div className="profile-setup-success" role="status">
            <CheckCircle2 size={28} />
            <strong>{draft.name}</strong>
            <p>
              Saved locally. No requests sent and no spending settings changed for other profiles.
            </p>
            <UiV2.Button onClick={onCancel}>Done</UiV2.Button>
          </div>
        ) : (
          <>
            <ol className="profile-setup-steps" aria-label="Profile setup steps">
              {steps.map((label, index) => (
                <li key={label} aria-current={step === index ? 'step' : undefined}>
                  <span>{index + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
            <div className="profile-setup-body">
              <h3>{steps[step]}</h3>
              <p className="muted">{explanations[step]}</p>
              {step === 0 && (
                <div className="grid gap-4">
                  <label className="grid gap-2">
                    Profile name
                    <UiV2.Input
                      value={draft.name}
                      onChange={(e) => {
                        patch({ name: e.target.value });
                      }}
                      maxLength={80}
                    />
                  </label>
                  <Select
                    label="What matters most?"
                    value={draft.routingObjective ?? 'balanced'}
                    onValueChange={(v) => {
                      patch({ routingObjective: v as Profile['routingObjective'] });
                    }}
                    options={[
                      { value: 'balanced', label: 'Balanced — recommended' },
                      { value: 'latency', label: 'Fast responses' },
                      { value: 'quality', label: 'Best suitable quality' },
                      { value: 'context', label: 'Long conversations' },
                    ]}
                  />
                </div>
              )}
              {step === 1 && (
                <div className="grid gap-3">
                  <Select
                    label="Provider selection"
                    value={Array.isArray(draft.allowedProviders) ? 'pick' : draft.allowedProviders}
                    options={[
                      { value: 'all_free', label: 'All eligible free providers — recommended' },
                      { value: 'all', label: 'All connected providers' },
                      { value: 'pick', label: 'Choose providers' },
                    ]}
                    onValueChange={(value) => {
                      patch({
                        allowedProviders:
                          value === 'pick'
                            ? connected.filter((p) => p.tag !== 'paid').map((p) => p.id)
                            : (value as 'all' | 'all_free'),
                      });
                    }}
                  />
                  <label className="profile-setup-cli-backup">
                    <UiV2.Checkbox
                      checked={draft.allowSubscriptionCli ?? false}
                      onCheckedChange={(checked) => {
                        patch({ allowSubscriptionCli: checked === true });
                      }}
                    />
                    <span>
                      Use signed-in CLI subscriptions as backup
                      <small>
                        Free models are tried first. Enable and verify connections in Providers
                        &amp; keys. This does not authorize metered usage or overage.
                      </small>
                    </span>
                  </label>
                  {Array.isArray(draft.allowedProviders) && (
                    <ul className="profile-setup-choices">
                      {providers.map((p) => (
                        <li key={p.id}>
                          <label>
                            <UiV2.Checkbox
                              checked={providerAllowed(draft.allowedProviders, p)}
                              onCheckedChange={(checked) => {
                                patch({
                                  allowedProviders: toggleProvider(
                                    draft.allowedProviders,
                                    providers,
                                    p.id,
                                    checked === true,
                                  ),
                                });
                              }}
                            />
                            <span aria-hidden="true">
                              <ProviderLogo providerId={p.id} name={p.name} size={20} />
                            </span>
                            <span>
                              {p.name}
                              <small>
                                {connected.some((c) => c.id === p.id)
                                  ? 'Connected'
                                  : 'Connect before use'}
                              </small>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {step === 3 && (
                <div className="grid gap-3">
                  <Select
                    label="Model selection"
                    value={manual ? 'pick' : 'auto'}
                    options={[
                      { value: 'auto', label: 'Auto chooses suitable models — recommended' },
                      { value: 'pick', label: 'Choose models and fallback order' },
                    ]}
                    onValueChange={(value) => {
                      setManual(value === 'pick');
                    }}
                  />
                  {manual && (
                    <>
                      <label className="profile-setup-search">
                        <Search size={16} />
                        <UiV2.Input
                          aria-label="Search profile models"
                          value={query}
                          onChange={(e) => {
                            setQuery(e.target.value);
                          }}
                          placeholder="Search models or providers"
                        />
                      </label>
                      <ul className="profile-setup-choices">
                        {visible.slice(0, 100).map((m) => (
                          <li key={m.ref}>
                            <label>
                              <UiV2.Checkbox
                                checked={selected.includes(m.ref)}
                                onCheckedChange={(checked) => {
                                  setSelected((current) =>
                                    checked === true
                                      ? [...current, m.ref]
                                      : current.filter((ref) => ref !== m.ref),
                                  );
                                }}
                              />
                              <span aria-hidden="true">
                                <ProviderLogo providerId={m.providerId} name={m.name} size={20} />
                              </span>
                              <span>
                                {m.name}
                                <small>
                                  {m.providerId} ·{' '}
                                  {m.free
                                    ? 'Free'
                                    : m.cliCapabilities?.billing === 'included_subscription'
                                      ? 'Included subscription'
                                      : 'Paid'}
                                </small>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      {visible.length > 100 && (
                        <p className="muted text-ui-meta">
                          Showing 100 of {visible.length}. Search to narrow the list.
                        </p>
                      )}
                      {!available.length && (
                        <p role="status">
                          No eligible models yet. Connect providers or use Auto until they are
                          ready.
                        </p>
                      )}
                      {selected.length > 0 && (
                        <>
                          <h4>Fallback order</h4>
                          <p className="muted text-ui-meta">
                            Drag a model to move it, or use the up and down buttons. Ferry only uses
                            your selected models; their capabilities and limits still apply.
                          </p>
                          <ol className="profile-setup-order">
                            {selected.map((ref, index) => (
                              <li
                                key={ref}
                                draggable
                                onDragStart={() => {
                                  setDragged(index);
                                }}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                }}
                                onDragEnd={() => {
                                  setDragged(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  if (dragged !== null) move(dragged, index);
                                  setDragged(null);
                                }}
                              >
                                <GripVertical aria-hidden="true" size={16} />
                                <span>
                                  {models.find((m) => m.ref === ref)?.name ?? ref}
                                  {!available.some((m) => m.ref === ref) && (
                                    <small>Excluded by your provider/spending choices</small>
                                  )}
                                </span>
                                <UiV2.Button
                                  size="icon"
                                  variant="ghost"
                                  disabled={index === 0}
                                  aria-label={`Move ${ref} up`}
                                  onClick={() => {
                                    move(index, index - 1);
                                  }}
                                >
                                  <ArrowUp size={16} />
                                </UiV2.Button>
                                <UiV2.Button
                                  size="icon"
                                  variant="ghost"
                                  disabled={index === selected.length - 1}
                                  aria-label={`Move ${ref} down`}
                                  onClick={() => {
                                    move(index, index + 1);
                                  }}
                                >
                                  <ArrowDown size={16} />
                                </UiV2.Button>
                              </li>
                            ))}
                          </ol>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
              {step === 2 && (
                <div className="grid gap-4">
                  <label className="flex items-center gap-3">
                    <UiV2.Checkbox
                      checked={draft.paidAllowed}
                      onCheckedChange={(checked) => {
                        patch({
                          paidAllowed: checked === true,
                          paidConfirmation: {
                            preauthorize: false,
                            confirmSubscriptions: false,
                            confirmTrials: false,
                          },
                        });
                      }}
                    />
                    Allow paid models
                  </label>
                  <p className="muted">
                    Paid models still need explicit authorization and available budget. This wizard
                    never enables paid backup on existing Gateway keys.
                  </p>
                  {draft.paidAllowed && (
                    <label className="grid gap-2">
                      Monthly spending limit (USD)
                      <UiV2.Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={draft.caps.monthlyUsd ?? ''}
                        onChange={(e) => {
                          patch({
                            caps: {
                              ...draft.caps,
                              monthlyUsd: e.target.value ? Number(e.target.value) : null,
                            },
                          });
                        }}
                      />
                    </label>
                  )}
                  <CliModelDefaults
                    models={
                      manual ? available.filter((model) => selected.includes(model.ref)) : available
                    }
                    defaults={draft.cliDefaults ?? {}}
                    onChange={(cliDefaults) => {
                      patch({ cliDefaults });
                    }}
                  />
                </div>
              )}
              {step === 4 && (
                <Select
                  label="Optimization"
                  value={optimizationPreset(draft.optimizers)}
                  options={[
                    { value: 'fidelity', label: 'Preserve fidelity — recommended' },
                    { value: 'savings', label: 'Safe savings' },
                    { value: 'advanced', label: 'Keep existing custom settings' },
                  ]}
                  onValueChange={(value) => {
                    if (value === 'fidelity' || value === 'savings')
                      patch({ optimizers: { ...OPTIMIZATION_PRESETS[value] } });
                  }}
                />
              )}
              {step === 5 && (
                <dl className="profile-setup-review">
                  <dt>Name</dt>
                  <dd>{draft.name}</dd>
                  <dt>Priority</dt>
                  <dd>
                    {
                      {
                        balanced: 'Balanced',
                        latency: 'Fast responses',
                        quality: 'Best suitable quality',
                        context: 'Long conversations',
                      }[draft.routingObjective ?? 'balanced']
                    }
                  </dd>
                  <dt>Providers</dt>
                  <dd>
                    {Array.isArray(draft.allowedProviders)
                      ? draft.allowedProviders
                          .map((id) => providers.find((p) => p.id === id)?.name ?? id)
                          .join(', ')
                      : draft.allowedProviders === 'all_free'
                        ? 'All eligible free providers'
                        : 'All connected providers'}
                  </dd>
                  <dt>Models</dt>
                  <dd>
                    {manual
                      ? usableSelected
                          .map((ref) => models.find((m) => m.ref === ref)?.name ?? ref)
                          .join(' → ')
                      : 'Auto chooses suitable models'}
                  </dd>
                  <dt>Spending</dt>
                  <dd>
                    {draft.paidAllowed
                      ? `Paid allowed, monthly cap $${String(draft.caps.monthlyUsd)}`
                      : 'Free only'}
                  </dd>
                  <dt>Optimization</dt>
                  <dd>
                    {
                      {
                        fidelity: 'Preserve fidelity',
                        savings: 'Safe savings',
                        advanced: 'Existing custom settings',
                      }[optimizationPreset(draft.optimizers)]
                    }
                  </dd>
                </dl>
              )}
            </div>
            {(error || validation) && (
              <p role="alert" className="text-destructive">
                {error || validation}
              </p>
            )}
            <footer className="profile-setup-footer">
              <UiV2.Button variant="ghost" disabled={busy} onClick={onCancel}>
                Cancel
              </UiV2.Button>
              <div className="button-row">
                <UiV2.Button
                  variant="secondary"
                  disabled={step === 0 || busy}
                  onClick={() => {
                    setError('');
                    setQuery('');
                    setStep(step - 1);
                  }}
                >
                  Back
                </UiV2.Button>
                {step < 5 ? (
                  <UiV2.Button
                    disabled={!!validation}
                    onClick={() => {
                      setQuery('');
                      setStep(step + 1);
                    }}
                  >
                    Continue
                  </UiV2.Button>
                ) : (
                  <UiV2.Button disabled={busy} onClick={() => void finish()}>
                    {busy ? 'Saving…' : 'Save profile'}
                  </UiV2.Button>
                )}
              </div>
            </footer>
          </>
        )}
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}
