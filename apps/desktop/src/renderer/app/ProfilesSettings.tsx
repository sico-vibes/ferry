import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { listAllModels } from '@ferry/client';
import { SkeletonRows, ProviderLogo, SegmentedControl, Select, Switch, UiV2 } from '@ferry/ui';
import {
  DIRECT_PROFILE_ID,
  type Profile,
  type Provider,
  type StepKind,
  type Tier,
} from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { keys, useProfiles, useSettings } from '../data/queries';
import { ConfirmDialog } from './ConfirmDialog';
import {
  allowedProvidersMode,
  isProfileDirty,
  newProfileFrom,
  providerAllowed,
  toggleProvider,
  toggleTier,
  type AllowedProvidersMode,
} from './profileDraft';

const stepRows: { kind: StepKind; label: string; helper: string }[] = [
  { kind: 'plan', label: 'Planning', helper: 'Breaking a task into steps' },
  { kind: 'edit', label: 'Editing code', helper: 'Writing and changing files' },
  { kind: 'search', label: 'Searching', helper: 'Reading and finding code' },
  { kind: 'summarize', label: 'Summarizing', helper: 'Compacting long history' },
  { kind: 'review', label: 'Reviewing', helper: 'Checking finished work' },
  { kind: 'long_context', label: 'Long context', helper: 'Very large inputs' },
];
const tierColumns: { tier: Tier; label: string }[] = [
  { tier: 'T1', label: 'Top' },
  { tier: 'T2', label: 'Strong' },
  { tier: 'T3', label: 'Light' },
];

function ProfileSection({
  title,
  helper,
  children,
}: {
  title: string;
  helper: string;
  children: ReactNode;
}) {
  return (
    <section className="profile-section">
      <header>
        <h3>{title}</h3>
        <p>{helper}</p>
      </header>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="v2-settings-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ToggleRow({
  title,
  helper,
  checked,
  onCheckedChange,
}: {
  title: string;
  helper: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <small>{helper}</small>
      </div>
      <Switch label={title} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function capValue(value: string): number | null {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Profiles settings: pick one profile from a menu, then edit it top to bottom. */
export function ProfilesSettings() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const { data: allProfiles = [], isPending: profilesPending } = useProfiles();
  const { data: settings } = useSettings();
  const { data: providers = [], isPending: providersPending } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: models = [], isPending: modelsPending } = useQuery({
    queryKey: ['models'],
    queryFn: () => listAllModels(client),
  });
  const profiles = useMemo(
    () => allProfiles.filter((profile) => profile.id !== DIRECT_PROFILE_ID),
    [allProfiles],
  );
  const [draft, setDraft] = useState<Profile | null>(null);
  const [feedback, setFeedback] = useState<
    { kind: 'saved' } | { kind: 'error'; message: string } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const saved = draft ? profiles.find((profile) => profile.id === draft.id) : undefined;
  const dirty = isProfileDirty(draft, saved);
  useEffect(() => {
    if (draft || profiles.length === 0) return;
    const active = profiles.find((profile) => profile.id === settings?.activeProfileId);
    const first = active ?? profiles[0];
    if (first) setDraft(structuredClone(first));
  }, [draft, profiles, settings?.activeProfileId]);
  const connectedIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.enabled && ['valid', 'unchecked', 'not_applicable'].includes(provider.keyStatus),
      )
      .map((provider) => provider.id),
  );
  const sortedProviders = [...providers].sort(
    (a, b) =>
      Number(connectedIds.has(b.id)) - Number(connectedIds.has(a.id)) ||
      a.name.localeCompare(b.name),
  );
  const patch = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setFeedback(null);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };
  const open = (profile: Profile) => {
    setFeedback(null);
    setDraft(structuredClone(profile));
  };
  const save = async () => {
    if (!draft || providersPending || modelsPending || !settings) return;
    try {
      const result = await client.profiles.save(draft);
      await cache.invalidateQueries({ queryKey: keys.profiles });
      setDraft(structuredClone(result));
      setFeedback({ kind: 'saved' });
    } catch (error) {
      setFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const remove = async () => {
    if (!draft || draft.builtin) return;
    await client.profiles.remove(draft.id);
    await cache.invalidateQueries({ queryKey: keys.profiles });
    setDraft(null);
  };
  const createFrom = (source: Profile | undefined, name: string) => {
    if (!source) return;
    setFeedback(null);
    setDraft(newProfileFrom(source, name, Date.now()));
  };
  if (!draft || providersPending || modelsPending || !settings)
    return (
      <div className="profile-settings-v3">
        {profilesPending || providersPending || modelsPending || !settings ? (
          <section className="profile-section">
            <SkeletonRows rows={5} />
          </section>
        ) : (
          <section className="profile-section">
            <p className="muted">No profiles yet. Create a profile to choose models and limits.</p>
          </section>
        )}
      </div>
    );
  const locked = draft.builtin;
  const mode = allowedProvidersMode(draft.allowedProviders);
  const chain = draft.fallbackChain ?? [];
  const isNew = !saved;
  const selectOptions = [
    ...(isNew ? [{ value: draft.id, label: `${draft.name} (unsaved)` }] : []),
    ...profiles.map((profile) => ({
      value: profile.id,
      label: profile.builtin ? `${profile.name} · built-in` : profile.name,
    })),
  ];
  return (
    <div className="profile-settings-v3">
      <p className="profile-intro">
        A profile tells Ferry which models it may use for each kind of work and how much it may
        spend. Chats can also skip profiles: pick <strong>No profile</strong> in the model menu and
        choose the model yourself.
      </p>
      <div className="profile-picker-row">
        <div className="profile-picker-select">
          <Select
            label="Profile to edit"
            value={draft.id}
            onValueChange={(id) => {
              const next = profiles.find((profile) => profile.id === id);
              if (next) open(next);
            }}
            options={selectOptions}
          />
        </div>
        <UiV2.Button
          variant="secondary"
          onClick={() => {
            createFrom(
              profiles.find((profile) => profile.id === 'profile_builtin_auto_free') ?? profiles[0],
              'New profile',
            );
          }}
        >
          <Plus aria-hidden="true" size={16} />
          New profile
        </UiV2.Button>
        <UiV2.Button
          aria-label={`Duplicate ${draft.name}`}
          title="Duplicate"
          size="icon"
          variant="ghost"
          onClick={() => {
            createFrom(draft, `${draft.name} copy`);
          }}
        >
          <Copy aria-hidden="true" size={16} />
        </UiV2.Button>
        <UiV2.Button
          aria-label={`Delete ${draft.name}`}
          title={locked ? 'Built-in profiles cannot be deleted' : 'Delete'}
          size="icon"
          variant="ghost"
          disabled={locked || isNew}
          onClick={() => {
            setConfirmDelete(true);
          }}
        >
          <Trash2 aria-hidden="true" size={16} />
        </UiV2.Button>
      </div>
      {locked ? (
        <div className="profile-locked-note" role="note">
          <span>
            {draft.name} is built in. You can change its fallback order and planner/editor split
            here. Duplicate it to change anything else.
          </span>
          <UiV2.Button
            size="sm"
            variant="secondary"
            onClick={() => {
              createFrom(draft, `${draft.name} copy`);
            }}
          >
            Duplicate to customize
          </UiV2.Button>
        </div>
      ) : null}

      <fieldset className="profile-fieldset" disabled={locked}>
        <ProfileSection title="Basics" helper="How this profile appears in menus.">
          <div className="profile-grid">
            <Field label="Name">
              <UiV2.Input
                value={draft.name}
                onChange={(event) => {
                  patch('name', event.target.value);
                }}
              />
            </Field>
            <Field label="Description">
              <UiV2.Input
                value={draft.description}
                placeholder="What is this profile for?"
                onChange={(event) => {
                  patch('description', event.target.value);
                }}
              />
            </Field>
          </div>
          <ToggleRow
            title="Show in quick switch"
            helper="List this profile when you cycle profiles from the keyboard."
            checked={draft.pinned}
            onCheckedChange={(value) => {
              patch('pinned', value);
            }}
          />
        </ProfileSection>

        <ProfileSection
          title="Models it can use"
          helper="Ferry only routes to models from these providers. Connected providers are listed first."
        >
          <SegmentedControl
            label="Allowed providers"
            value={mode}
            onValueChange={(value) => {
              const next = value as AllowedProvidersMode;
              patch(
                'allowedProviders',
                next === 'pick'
                  ? providers
                      .filter((provider) => providerAllowed(draft.allowedProviders, provider))
                      .map((provider) => provider.id)
                  : next,
              );
            }}
            options={[
              { value: 'all_free', label: 'Free only' },
              { value: 'all', label: 'Free and paid' },
              { value: 'pick', label: 'Choose providers' },
            ]}
          />
          {mode === 'pick' ? (
            <div className="profile-provider-grid">
              {sortedProviders.map((provider) => {
                const id = `profile-provider-${provider.id}`;
                return (
                  <label className="profile-provider-option" htmlFor={id} key={provider.id}>
                    <UiV2.Checkbox
                      id={id}
                      aria-label={provider.name}
                      checked={providerAllowed(draft.allowedProviders, provider)}
                      onCheckedChange={(checked) => {
                        patch(
                          'allowedProviders',
                          toggleProvider(
                            draft.allowedProviders,
                            providers,
                            provider.id,
                            checked === true,
                          ),
                        );
                      }}
                    />
                    <ProviderLogo name={provider.name} providerId={provider.id} size={16} />
                    <span>{provider.name}</span>
                    {connectedIds.has(provider.id) ? (
                      <small className="profile-provider-connected">Connected</small>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ) : null}
        </ProfileSection>

        <ProfileSection
          title="Model strength per task"
          helper="Top models are the most capable, Light models the fastest and cheapest. Ferry picks from the strengths you allow for each kind of work."
        >
          <div className="profile-tier-table" role="table" aria-label="Model strength per task">
            <div className="profile-tier-row is-head" role="row">
              <span role="columnheader">Task</span>
              {tierColumns.map((column) => (
                <span key={column.tier} role="columnheader">
                  {column.label}
                </span>
              ))}
            </div>
            {stepRows.map((row) => (
              <div className="profile-tier-row" key={row.kind} role="row">
                <span role="rowheader">
                  <strong>{row.label}</strong>
                  <small>{row.helper}</small>
                </span>
                {tierColumns.map((column) => {
                  const on = draft.tierByStep[row.kind].includes(column.tier);
                  return (
                    <span key={column.tier} role="cell">
                      <button
                        type="button"
                        className="profile-tier-chip"
                        aria-pressed={on}
                        aria-label={`${row.label}: ${column.label} models`}
                        onClick={() => {
                          patch('tierByStep', toggleTier(draft.tierByStep, row.kind, column.tier));
                        }}
                      >
                        {column.label}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </ProfileSection>

        <ProfileSection
          title="Paid models and spending"
          helper="Free models are always tried first. Global caps in Routing still apply on top of these."
        >
          <ToggleRow
            title="Allow paid models"
            helper="Use paid models when free capacity is unavailable."
            checked={draft.paidAllowed}
            onCheckedChange={(value) => {
              patch('paidAllowed', value);
            }}
          />
          {draft.paidAllowed ? (
            <>
              <ToggleRow
                title="Skip the first paid-call prompt"
                helper="Pre-authorize paid calls for chats that use this profile."
                checked={draft.paidConfirmation.preauthorize}
                onCheckedChange={(value) => {
                  patch('paidConfirmation', { ...draft.paidConfirmation, preauthorize: value });
                }}
              />
              <div className="profile-grid three">
                {(
                  [
                    ['sessionUsd', 'Per chat'],
                    ['dailyUsd', 'Per day'],
                    ['monthlyUsd', 'Per month'],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={`${label} cap ($)`}>
                    <UiV2.Input
                      inputMode="decimal"
                      placeholder="No cap"
                      value={draft.caps[key]?.toString() ?? ''}
                      onChange={(event) => {
                        patch('caps', { ...draft.caps, [key]: capValue(event.target.value) });
                      }}
                    />
                  </Field>
                ))}
              </div>
            </>
          ) : null}
          <ToggleRow
            title="Ask before subscription accounts"
            helper="Confirm before using a subscription sign-in or CLI account."
            checked={draft.paidConfirmation.confirmSubscriptions}
            onCheckedChange={(value) => {
              patch('paidConfirmation', { ...draft.paidConfirmation, confirmSubscriptions: value });
            }}
          />
          <ToggleRow
            title="Ask before trial credits"
            helper="Confirm before spending provider trial or credit balances."
            checked={draft.paidConfirmation.confirmTrials}
            onCheckedChange={(value) => {
              patch('paidConfirmation', { ...draft.paidConfirmation, confirmTrials: value });
            }}
          />
        </ProfileSection>
      </fieldset>

      <ProfileSection
        title="Fallback order"
        helper="Optional. Providers to try first, in order, before Ferry scores everything else. Drag to reorder."
      >
        {chain.length ? (
          <ol className="profile-chain">
            {chain.map((entry, index) => (
              <li
                key={`${entry.provider}-${String(index)}`}
                className="profile-chain-item"
                draggable
                onDragStart={() => {
                  setDragIndex(index);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={() => {
                  if (dragIndex === null || dragIndex === index) return;
                  const next = [...chain];
                  const [moved] = next.splice(dragIndex, 1);
                  if (moved) next.splice(index, 0, moved);
                  patch('fallbackChain', next);
                  setDragIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                }}
              >
                <GripVertical aria-hidden="true" className="profile-chain-grip" size={16} />
                <span className="profile-chain-index">{index + 1}</span>
                <div className="profile-chain-provider">
                  <Select
                    label={`Fallback provider ${String(index + 1)}`}
                    value={entry.provider}
                    onValueChange={(value) => {
                      const next = [...chain];
                      next[index] = { ...entry, provider: value as Provider['id'] };
                      patch('fallbackChain', next);
                    }}
                    options={sortedProviders.map((provider) => ({
                      value: provider.id,
                      label: provider.name,
                    }))}
                  />
                </div>
                <UiV2.Input
                  aria-label={`Model patterns for fallback ${String(index + 1)}`}
                  placeholder="All models, or patterns like glm-*, kimi-k2*"
                  value={entry.patterns.filter((pattern) => pattern !== '*').join(', ')}
                  onChange={(event) => {
                    const next = [...chain];
                    const patterns = event.target.value
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean);
                    next[index] = { ...entry, patterns: patterns.length ? patterns : ['*'] };
                    patch('fallbackChain', next);
                  }}
                />
                <UiV2.Button
                  aria-label={`Remove fallback ${String(index + 1)}`}
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    const next = chain.filter((_, i) => i !== index);
                    patch('fallbackChain', next.length ? next : undefined);
                  }}
                >
                  <X aria-hidden="true" size={16} />
                </UiV2.Button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No fallback order. Ferry scores every allowed model.</p>
        )}
        <div>
          <UiV2.Button
            size="sm"
            variant="secondary"
            disabled={providers.every((provider) =>
              chain.some((entry) => entry.provider === provider.id),
            )}
            onClick={() => {
              const provider = sortedProviders.find(
                (item) => !chain.some((entry) => entry.provider === item.id),
              );
              if (!provider) return;
              patch('fallbackChain', [...chain, { provider: provider.id, patterns: ['*'] }]);
            }}
          >
            <Plus aria-hidden="true" size={16} />
            Add provider
          </UiV2.Button>
        </div>
      </ProfileSection>

      <ProfileSection
        title="Planner and editor"
        helper="Optional. One model writes a file-by-file plan and another applies it."
      >
        <ToggleRow
          title="Split planning and editing"
          helper="Useful when a strong model plans and a fast model edits."
          checked={draft.roles.enabled}
          onCheckedChange={(enabled) => {
            patch('roles', { ...draft.roles, enabled });
          }}
        />
        {draft.roles.enabled ? (
          <div className="profile-grid">
            {(['plannerModelRef', 'editorModelRef'] as const).map((key) => (
              <Field key={key} label={key === 'plannerModelRef' ? 'Planner model' : 'Editor model'}>
                <Select
                  label={key === 'plannerModelRef' ? 'Planner model' : 'Editor model'}
                  value={draft.roles[key] ?? 'auto'}
                  onValueChange={(value) => {
                    patch('roles', { ...draft.roles, [key]: value === 'auto' ? null : value });
                  }}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    ...models
                      .filter((model) => connectedIds.has(model.providerId))
                      .map((model) => ({ value: model.ref, label: model.name })),
                  ]}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </ProfileSection>

      <fieldset className="profile-fieldset" disabled={locked}>
        <ProfileSection
          title="Advanced"
          helper="Account stickiness, delegation and token-saving defaults."
        >
          <div className="setting-row">
            <div>
              <strong>Account affinity</strong>
              <small>Keep a chat on the same provider account to reuse its prompt cache.</small>
            </div>
            <Select
              label="Account affinity"
              value={draft.affinityMode}
              onValueChange={(value) => {
                patch('affinityMode', value as Profile['affinityMode']);
              }}
              options={[
                { value: 'soft', label: 'Switch after a failure' },
                { value: 'strict', label: 'Always keep the account' },
              ]}
            />
          </div>
          <div className="setting-row">
            <div>
              <strong>Delegation</strong>
              <small>When Ferry can hand work to another coding agent.</small>
            </div>
            <SegmentedControl
              label="Delegation mode"
              value={draft.delegationMode}
              onValueChange={(value) => {
                patch('delegationMode', value as Profile['delegationMode']);
              }}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'suggest', label: 'Suggest' },
                { value: 'auto', label: 'Auto' },
              ]}
            />
          </div>
        </ProfileSection>
        <ProfileSection
          title="Optimization"
          helper="Save tokens in older conversation and choose how Ferry replies."
        >
          <div className="setting-row">
            <div>
              <strong>Compress older conversation (Caveman)</strong>
              <small>
                {
                  {
                    off: 'Keep conversation text unchanged.',
                    lite: 'Remove filler from older prose; preserve technical details.',
                    standard: 'Shorten older prose further; preserve technical details.',
                  }[draft.optimizers.cavemanInput]
                }
              </small>
            </div>
            <SegmentedControl
              label="Compress older conversation (Caveman)"
              value={draft.optimizers.cavemanInput}
              onValueChange={(value) => {
                patch('optimizers', {
                  ...draft.optimizers,
                  cavemanInput: value as Profile['optimizers']['cavemanInput'],
                });
              }}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'lite', label: 'Lite' },
                { value: 'standard', label: 'Standard' },
              ]}
            />
          </div>
          <div className="setting-row">
            <div>
              <strong>Reply style</strong>
              <small>
                {
                  {
                    off: 'Normal prose with full response detail.',
                    lite: 'Concise, complete sentences without filler.',
                    full: 'Short fragments with all technical substance.',
                    ultra: 'Telegraphic replies with common prose abbreviations.',
                  }[draft.optimizers.terse]
                }{' '}
                Tool arguments and file contents stay complete.
              </small>
            </div>
            <SegmentedControl
              label="Reply style"
              value={draft.optimizers.terse}
              onValueChange={(value) => {
                patch('optimizers', {
                  ...draft.optimizers,
                  terse: value as Profile['optimizers']['terse'],
                });
              }}
              options={['off', 'lite', 'full', 'ultra'].map((value) => ({
                value,
                label: value === 'off' ? 'Normal' : value.charAt(0).toUpperCase() + value.slice(1),
              }))}
            />
          </div>
          {(
            [
              ['toolOutputFilters', 'Tool-output filters', 'Trim noisy command output.'],
              [
                'recoveryHandles',
                'Recovery handles',
                'Keep full output retrievable after trimming.',
              ],
              ['contextHygiene', 'Context hygiene', 'Drop stale context between steps.'],
              ['rtk', 'RTK', 'Compress shell output with RTK when installed.'],
            ] as const
          ).map(([key, title, helper]) => (
            <ToggleRow
              key={key}
              title={title}
              helper={helper}
              checked={draft.optimizers[key]}
              onCheckedChange={(value) => {
                patch('optimizers', { ...draft.optimizers, [key]: value });
              }}
            />
          ))}
        </ProfileSection>
      </fieldset>

      {dirty || isNew || feedback ? (
        <div className="profile-save-bar" role="region" aria-label="Profile changes">
          {feedback?.kind === 'error' ? (
            <span className="v2-settings-save-error" role="alert">
              Could not save: {feedback.message}
            </span>
          ) : feedback?.kind === 'saved' && !dirty ? (
            <span aria-label="Saved" className="v2-settings-save-success" role="status">
              Saved
            </span>
          ) : (
            <span className="muted">
              {isNew ? 'New profile, not saved yet' : 'Unsaved changes'}
            </span>
          )}
          {dirty || isNew ? (
            <div className="button-row">
              <UiV2.Button
                variant="ghost"
                onClick={() => {
                  const fallback = saved ?? profiles[0];
                  if (fallback) open(fallback);
                }}
              >
                Discard
              </UiV2.Button>
              <UiV2.Button onClick={() => void save()}>Save profile</UiV2.Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${draft.name}?`}
        description="This permanently removes the profile. Chats that used it switch to Auto-Free."
        confirmLabel="Delete profile"
        destructive
        onConfirm={() => void remove()}
      />
    </div>
  );
}
