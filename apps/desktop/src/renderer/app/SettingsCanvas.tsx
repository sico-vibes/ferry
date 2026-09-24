import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useFerryClient } from '../data/client';
import { keys, useProfiles, useSettings } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import {
  Checkbox,
  Dialog,
  FerryMark,
  Pill,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  TextField,
} from '@ferry/ui';
import type { Profile, StepKind, Tier } from '@ferry/shared';
import { ProviderKeyDialog } from './ProviderKeyDialog';
const stepKinds: StepKind[] = ['plan', 'edit', 'search', 'summarize', 'review', 'long_context'];
const stepLabels: Record<StepKind, string> = {
  plan: 'Plan',
  edit: 'Edit',
  search: 'Search',
  summarize: 'Summarize',
  review: 'Review',
  long_context: 'Long context',
};

function isPermissionRule(
  value: unknown,
): value is { effect: string; pattern: string; tool: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.effect === 'string' &&
    ['allow', 'ask', 'deny'].includes(rule.effect) &&
    typeof rule.pattern === 'string' &&
    typeof rule.tool === 'string'
  );
}

export function SettingsCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const toast = useToasts((state) => state.push);
  const section = useUI((state) => state.settingsSection);
  const [confirm, setConfirm] = useState('');
  const [confirmAction, setConfirmAction] = useState<(() => void | Promise<void>) | null>(null);
  const [keyProvider, setKeyProvider] = useState<(typeof providers)[number] | null>(null);
  const [addMcp, setAddMcp] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpAddress, setMcpAddress] = useState('');
  const [benchmarkMode, setBenchmarkMode] = useState(
    () => localStorage.getItem('ferry.benchmarkMode') === 'true',
  );
  const [logRetention, setLogRetention] = useState(
    () => localStorage.getItem('ferry.logRetention') ?? '30',
  );
  const { data: settings } = useSettings();
  const { data: profiles = [] } = useProfiles();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: lanes = [] } = useQuery({
    queryKey: ['lanes'],
    queryFn: () => client.delegation.lanes(),
  });
  const { data: skills = [] } = useQuery({
    queryKey: ['skills'],
    queryFn: () => client.skills.list(),
  });
  const { data: mcps = [] } = useQuery({ queryKey: keys.mcp, queryFn: () => client.mcp.list() });
  const { data: optimizerStats } = useQuery({
    queryKey: ['optimizer-stats'],
    queryFn: () => client.optimizer.stats(),
  });
  const { data: info } = useQuery({
    queryKey: ['system-info'],
    queryFn: () => client.system.info(),
  });
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const testProvider = async (provider: (typeof providers)[number]) => {
    setTestingProvider(provider.id);
    try {
      const result = await client.providers.probe(provider.id);
      toast({
        kind: result.ok ? 'success' : 'error',
        title: result.ok
          ? `Connected · ${result.latencyMs === null ? 'CLI' : `${String(result.latencyMs)} ms`}`
          : 'Connection failed',
        body: result.ok
          ? `Next: choose ${provider.name} in a profile.`
          : `${result.message}. Check the key and try again.`,
      });
      await cache.invalidateQueries({ queryKey: ['providers'] });
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Connection test failed',
        body:
          error instanceof Error
            ? `${error.message}. Check the key and try again.`
            : 'Check the key and try again.',
      });
    } finally {
      setTestingProvider(null);
    }
  };
  const update = async (patch: Parameters<typeof client.settings.update>[0]) => {
    await client.settings.update(patch);
    await cache.invalidateQueries({ queryKey: keys.settings });
  };
  const mutateProfile = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setProfileDraft((current) => (current ? { ...current, [key]: value } : current));
  };
  const openProfile = (profile: Profile) => {
    setProfileDraft(structuredClone(profile));
  };
  const saveProfile = async () => {
    if (!profileDraft) return;
    await client.profiles.save(profileDraft);
    await cache.invalidateQueries({ queryKey: keys.profiles });
    toast({ kind: 'success', title: 'Profile saved', body: profileDraft.name });
  };
  const toggleOptimizer = (
    key: 'toolOutputFilters' | 'recoveryHandles' | 'contextHygiene' | 'rtk',
  ) => {
    if (settings)
      void update({ optimizers: { ...settings.optimizers, [key]: !settings.optimizers[key] } });
  };
  const toggleSkill = async (id: (typeof skills)[number]['id'], enabled: boolean) => {
    await client.skills.setEnabled(id, enabled);
    await cache.invalidateQueries({ queryKey: ['skills'] });
  };
  const toggleMcp = async (id: (typeof mcps)[number]['id'], enabled: boolean) => {
    await client.mcp.setEnabled(id, enabled);
    await cache.invalidateQueries({ queryKey: keys.mcp });
  };
  const body = () => {
    if (section === 'General')
      return (
        <>
          <Group title="Appearance">
            <SettingRow title="Theme" helper={'Choose dark, light, or follow your display.'}>
              <SegmentedControl
                label="Theme"
                value={settings?.theme ?? 'dark'}
                onValueChange={(value) =>
                  void update({ theme: value as NonNullable<typeof settings>['theme'] })
                }
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                  { value: 'system', label: 'System' },
                ]}
              />
            </SettingRow>
            <SettingRow title="Home style" helper="Choose when Home uses the compact layout.">
              <SegmentedControl
                label="Home style"
                value={settings?.homeStyle ?? 'auto'}
                onValueChange={(value) =>
                  void update({ homeStyle: value as NonNullable<typeof settings>['homeStyle'] })
                }
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'hero', label: 'Always show hero' },
                  { value: 'compact', label: 'Compact' },
                ]}
              />
            </SettingRow>
            <SettingRow title="Font scale" helper="Adjust interface text size.">
              <div className="range-control">
                <Slider
                  label="Font scale"
                  min={0.85}
                  max={1.3}
                  step={0.05}
                  value={settings?.fontScale ?? 1}
                  onValueChange={(value) => void update({ fontScale: value })}
                />
                <span>{(settings?.fontScale ?? 1).toFixed(2)}×</span>
              </div>
            </SettingRow>
            <SettingRow
              title="Restore tabs"
              helper="Reopen your last session tabs when Ferry starts."
            >
              <Switch
                label="Restore tabs"
                checked={settings?.restoreTabs ?? false}
                onCheckedChange={(restoreTabs) => void update({ restoreTabs })}
              />
            </SettingRow>
            <SettingRow title="First run" helper="Review the provider and workspace setup again.">
              <Pill size="sm" onClick={() => void navigate({ to: '/onboarding' })}>
                Run onboarding again
              </Pill>
            </SettingRow>
          </Group>
          <Group title="Quick access">
            <p className="muted">Your Ferry setup stays local to this demo client.</p>
          </Group>
        </>
      );
    if (section === 'Profiles')
      return (
        <div className="profile-settings">
          <div className="profile-list">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                className={`profile-option ${profileDraft?.id === profile.id ? 'is-active' : ''}`}
                onClick={() => {
                  openProfile(profile);
                }}
              >
                <span>
                  {profile.name}
                  {profile.pinned ? <small className="profile-pin">Pinned</small> : null}
                </span>
                <small>{profile.description}</small>
              </button>
            ))}
            <Pill
              size="sm"
              onClick={() => {
                const source = profiles[0];
                if (!source) return;
                const clone = {
                  ...structuredClone(source),
                  id: `profile_custom_${String(Date.now())}` as Profile['id'],
                  name: 'New profile',
                  builtin: false,
                  pinned: false,
                };
                setProfileDraft(clone);
              }}
            >
              New profile
            </Pill>
          </div>
          {profileDraft ? (
            <div className="profile-editor">
              <div className="group-title">
                <div>
                  <h2>{profileDraft.name}</h2>
                  <p>Edit routing and spending limits.</p>
                </div>
                <div className="button-row">
                  <Pill
                    size="sm"
                    onClick={() => {
                      const clone = {
                        ...structuredClone(profileDraft),
                        id: `profile_copy_${String(Date.now())}` as Profile['id'],
                        name: `${profileDraft.name} copy`,
                        builtin: false,
                        pinned: false,
                      };
                      setProfileDraft(clone);
                    }}
                  >
                    Duplicate
                  </Pill>
                  <Pill
                    size="sm"
                    disabled={profileDraft.builtin}
                    onClick={() => {
                      setConfirm(`Delete ${profileDraft.name}?`);
                      setConfirmAction(
                        () => () =>
                          void client.profiles.remove(profileDraft.id).then(async () => {
                            await cache.invalidateQueries({ queryKey: keys.profiles });
                            setProfileDraft(null);
                            toast({
                              kind: 'success',
                              title: 'Profile deleted',
                              body: 'You can create another profile in Settings.',
                            });
                          }),
                      );
                    }}
                  >
                    Delete
                  </Pill>
                  <Pill size="sm" variant="blue-tint" onClick={() => void saveProfile()}>
                    Save
                  </Pill>
                </div>
              </div>
              <div className="form-grid">
                <TextField
                  label="Name"
                  value={profileDraft.name}
                  onChange={(value) => {
                    mutateProfile('name', value);
                  }}
                />
                <Select
                  label="Icon"
                  value={profileDraft.icon}
                  onValueChange={(value) => {
                    mutateProfile('icon', value);
                  }}
                  options={['lightbulb', 'sparkles', 'zap', 'book-open', 'code', 'brain'].map(
                    (value) => ({ value, label: value }),
                  )}
                />
                <TextField
                  label="Description"
                  value={profileDraft.description}
                  onChange={(value) => {
                    mutateProfile('description', value);
                  }}
                />
              </div>
              <h3>Allowed providers</h3>
              <div className="check-grid">
                {providers.map((provider) => (
                  <Checkbox
                    key={provider.id}
                    label={provider.name}
                    checked={
                      profileDraft.allowedProviders === 'all' ||
                      (profileDraft.allowedProviders === 'all_free' && provider.tag !== 'paid') ||
                      profileDraft.allowedProviders.includes(provider.id)
                    }
                    onCheckedChange={(checked) => {
                      const current =
                        profileDraft.allowedProviders === 'all'
                          ? providers.map((item) => item.id)
                          : profileDraft.allowedProviders === 'all_free'
                            ? providers.filter((item) => item.tag !== 'paid').map((item) => item.id)
                            : profileDraft.allowedProviders;
                      mutateProfile(
                        'allowedProviders',
                        checked
                          ? [...new Set([...current, provider.id])]
                          : current.filter((id) => id !== provider.id),
                      );
                    }}
                  />
                ))}
              </div>
              <h3>Tier per step kind</h3>
              <div className="tier-table">
                <div className="tier-head">
                  <span>Step</span>
                  {(['T1', 'T2', 'T3'] as Tier[]).map((tier) => (
                    <span key={tier}>{tier}</span>
                  ))}
                </div>
                {stepKinds.map((kind) => (
                  <div className="tier-row" key={kind}>
                    <span>{stepLabels[kind]}</span>
                    {(['T1', 'T2', 'T3'] as Tier[]).map((tier) => (
                      <Checkbox
                        key={tier}
                        label={`${stepLabels[kind]} ${tier}`}
                        checked={profileDraft.tierByStep[kind].includes(tier)}
                        onCheckedChange={(checked) => {
                          mutateProfile('tierByStep', {
                            ...profileDraft.tierByStep,
                            [kind]: checked
                              ? [...profileDraft.tierByStep[kind], tier]
                              : profileDraft.tierByStep[kind].filter((value) => value !== tier),
                          });
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <SettingRow
                title="Paid models"
                helper="Allow paid models when free capacity is unavailable."
              >
                <Switch
                  label="Paid models"
                  checked={profileDraft.paidAllowed}
                  onCheckedChange={(value) => {
                    mutateProfile('paidAllowed', value);
                  }}
                />
              </SettingRow>
              <div className="form-grid">
                <TextField
                  label="Daily cap ($)"
                  value={profileDraft.caps.dailyUsd?.toString() ?? ''}
                  placeholder="No cap"
                  onChange={(value) => {
                    mutateProfile('caps', {
                      ...profileDraft.caps,
                      dailyUsd: value ? Number(value) : null,
                    });
                  }}
                />
                <TextField
                  label="Monthly cap ($)"
                  value={profileDraft.caps.monthlyUsd?.toString() ?? ''}
                  placeholder="No cap"
                  onChange={(value) => {
                    mutateProfile('caps', {
                      ...profileDraft.caps,
                      monthlyUsd: value ? Number(value) : null,
                    });
                  }}
                />
              </div>
              <SettingRow
                title="Delegation"
                helper="When Ferry can offer work to another coding agent."
              >
                <SegmentedControl
                  label="Delegation mode"
                  value={profileDraft.delegationMode}
                  onValueChange={(value) => {
                    mutateProfile('delegationMode', value as Profile['delegationMode']);
                  }}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'suggest', label: 'Suggest' },
                    { value: 'auto', label: 'Auto' },
                  ]}
                />
              </SettingRow>
              <h3>Optimizer defaults</h3>
              <SettingRow
                title="Terse level"
                helper="How much routine detail Ferry keeps in responses."
              >
                <SegmentedControl
                  label="Profile terse level"
                  value={profileDraft.optimizers.terse}
                  onValueChange={(value) => {
                    mutateProfile('optimizers', {
                      ...profileDraft.optimizers,
                      terse: value as Profile['optimizers']['terse'],
                    });
                  }}
                  options={['off', 'lite', 'full', 'ultra'].map((value) => ({
                    value,
                    label: value.charAt(0).toUpperCase() + value.slice(1),
                  }))}
                />
              </SettingRow>
              {(
                [
                  ['toolOutputFilters', 'Tool-output filters'],
                  ['recoveryHandles', 'Recovery handles'],
                  ['contextHygiene', 'Context hygiene'],
                  ['rtk', 'RTK'],
                ] as const
              ).map(([key, label]) => (
                <SettingRow
                  key={key}
                  title={label}
                  helper={`Use ${label.toLowerCase()} by default for this profile.`}
                >
                  <Switch
                    label={label}
                    checked={profileDraft.optimizers[key]}
                    onCheckedChange={(value) => {
                      mutateProfile('optimizers', { ...profileDraft.optimizers, [key]: value });
                    }}
                  />
                </SettingRow>
              ))}
            </div>
          ) : (
            <div className="empty-card">Select a profile to edit.</div>
          )}
        </div>
      );
    if (section === 'Providers & Keys')
      return (
        <Group title="Providers & Keys">
          <p className="muted">
            Keys are stored by the local client. Free tier data use depends on each provider's
            terms.
          </p>
          {providers.map((provider) => (
            <SettingRow
              key={provider.id}
              title={provider.name}
              helper={provider.dataUse ?? provider.termsNote ?? 'No data use note provided.'}
            >
              <span className={`status-pill ${provider.keyStatus === 'valid' ? 'ok' : 'pending'}`}>
                {provider.keyStatus.replace('_', ' ')}
              </span>
              <Pill
                size="sm"
                onClick={() => {
                  setKeyProvider(provider);
                }}
              >
                Manage key
              </Pill>
              <Pill
                size="sm"
                disabled={testingProvider === provider.id}
                variant="outline"
                onClick={() => void testProvider(provider)}
              >
                {testingProvider === provider.id ? 'Testing…' : 'Test'}
              </Pill>
            </SettingRow>
          ))}
          <Pill size="sm" variant="outline" onClick={() => void navigate({ to: '/explore' })}>
            Open in Explore
          </Pill>
        </Group>
      );
    if (section === 'Optimizers') {
      const terse = settings?.optimizers.terse ?? 'lite';
      const preview = {
        off: 'Ferry keeps the full response detail.',
        lite: 'Short answer, then the key files and next step.',
        full: 'Summarize routine tool output and keep decisions visible.',
        ultra: 'Only essential changes, risks, and the next action.',
      }[terse];
      return (
        <Group title="Optimizers">
          <SettingRow title="Terse level" helper={preview}>
            <SegmentedControl
              label="Terse level"
              value={terse}
              onValueChange={(value) => {
                if (settings)
                  void update({
                    optimizers: { ...settings.optimizers, terse: value as typeof terse },
                  });
              }}
              options={['off', 'lite', 'full', 'ultra'].map((value) => ({
                value,
                label: value.charAt(0).toUpperCase() + value.slice(1),
              }))}
            />
          </SettingRow>
          <SettingRow title="Tool-output filters" helper="Trim repeated build and test output.">
            <Switch
              label="Tool-output filters"
              checked={settings?.optimizers.toolOutputFilters ?? false}
              onCheckedChange={() => {
                toggleOptimizer('toolOutputFilters');
              }}
            />
          </SettingRow>
          <SettingRow title="Recovery handles" helper="Keep a way to recover filtered output.">
            <Switch
              label="Recovery handles"
              checked={settings?.optimizers.recoveryHandles ?? false}
              onCheckedChange={() => {
                toggleOptimizer('recoveryHandles');
              }}
            />
          </SettingRow>
          <SettingRow title="Context hygiene" helper="Remove stale context between steps.">
            <Switch
              label="Context hygiene"
              checked={settings?.optimizers.contextHygiene ?? false}
              onCheckedChange={() => {
                toggleOptimizer('contextHygiene');
              }}
            />
          </SettingRow>
          <SettingRow title="RTK" helper="Downloads a pinned, checksum-verified binary.">
            <Switch
              label="RTK"
              checked={settings?.optimizers.rtk ?? false}
              onCheckedChange={() => {
                toggleOptimizer('rtk');
              }}
            />
          </SettingRow>
          <SettingRow title="Benchmark mode" helper="Show measured changes for optimizer choices.">
            <Switch
              label="Benchmark mode"
              checked={benchmarkMode}
              onCheckedChange={(value) => {
                setBenchmarkMode(value);
                localStorage.setItem('ferry.benchmarkMode', String(value));
              }}
            />
          </SettingRow>
          <div className="stats-summary">
            <strong>
              {optimizerStats?.today.savedTokens.toLocaleString() ?? '0'} tokens saved today
            </strong>
            <span>{optimizerStats?.today.percent ?? 0}% · demo measurement</span>
          </div>
        </Group>
      );
    }
    if (section === 'Delegation')
      return (
        <Group title="Delegation">
          <SettingRow title="Mode" helper="Control whether Ferry can suggest or start a lane.">
            <SegmentedControl
              label="Delegation mode"
              value={settings?.delegationMode ?? 'suggest'}
              onValueChange={(value) =>
                void update({
                  delegationMode: value as NonNullable<typeof settings>['delegationMode'],
                })
              }
              options={[
                { value: 'off', label: 'Off' },
                { value: 'suggest', label: 'Suggest' },
                { value: 'auto', label: 'Auto' },
              ]}
            />
          </SettingRow>
          <h3>Merged lanes</h3>
          {lanes.map((lane) => (
            <div className="lane-row" key={lane.name}>
              <strong>{lane.implementer}</strong>
              <span>{lane.name}</span>
              <small>{lane.model ?? lane.effort ?? lane.variant ?? 'Default'}</small>
              <small>{lane.source}</small>
              <span className={`status-pill ${lane.trusted ? 'ok' : 'pending'}`}>
                {lane.trusted ? 'Trusted' : 'Untrusted'}
              </span>
            </div>
          ))}
          <h3>CLI detection</h3>
          {providers
            .filter((provider) => provider.kind === 'cli')
            .map((provider) => (
              <SettingRow
                key={provider.id}
                title={provider.name}
                helper={
                  provider.keyStatus === 'not_applicable' ? 'Detected' : 'Status not verified'
                }
              >
                <span className="status-pill ok">
                  {provider.keyStatus === 'not_applicable' ? 'Available' : 'Installed'}
                </span>
              </SettingRow>
            ))}
        </Group>
      );
    if (section === 'Permissions')
      return (
        <PermissionsContent
          mode={settings?.permissionMode ?? 'ask'}
          onMode={(value) =>
            void update({ permissionMode: value as NonNullable<typeof settings>['permissionMode'] })
          }
        />
      );
    if (section === 'Developer')
      return (
        <DeveloperSettings
          mockLatency={settings?.developer.mockLatency ?? false}
          injectErrors={settings?.developer.injectErrors ?? false}
          update={(patch) =>
            void update({
              developer: {
                showReferenceOverlay: settings?.developer.showReferenceOverlay ?? false,
                mockLatency: patch.mockLatency ?? settings?.developer.mockLatency ?? false,
                injectErrors: patch.injectErrors ?? settings?.developer.injectErrors ?? false,
              },
            })
          }
        />
      );
    if (section === 'Skills')
      return (
        <Group title="Skills">
          <p className="muted">Enable local instructions and workflows.</p>
          {skills.map((skill) => (
            <SettingRow key={skill.id} title={skill.name} helper={skill.description}>
              <Switch
                label={skill.name}
                checked={skill.enabled}
                onCheckedChange={(value) => void toggleSkill(skill.id, value)}
              />
            </SettingRow>
          ))}
          <Pill
            size="sm"
            onClick={() => {
              toast({
                kind: 'info',
                title: 'Import from ~/.claude/skills',
                body: 'Import is available in the connected desktop app.',
              });
            }}
          >
            Import from ~/.claude/skills
          </Pill>
        </Group>
      );
    if (section === 'MCP')
      return (
        <Group title="MCP servers">
          <p className="muted">Connect local tools through Model Context Protocol.</p>
          {mcps.map((server) => (
            <SettingRow
              key={server.id}
              title={server.name}
              helper={`${server.transport} · ${String(server.toolCount)} tools`}
            >
              <div className="inline-control">
                <span className="status-pill">{server.status}</span>
                <Switch
                  label={server.name}
                  checked={server.status === 'connected'}
                  onCheckedChange={(value) => void toggleMcp(server.id, value)}
                />
              </div>
            </SettingRow>
          ))}
          <Pill
            size="sm"
            onClick={() => {
              setAddMcp(true);
            }}
          >
            Add server
          </Pill>
        </Group>
      );
    if (section === 'Data & Privacy')
      return (
        <Group title="Data & Privacy">
          <p className="muted">
            Provider data practices vary by plan and endpoint. Review each provider's terms before
            adding a key.
          </p>
          {providers
            .filter((provider) => provider.dataUse)
            .map((provider) => (
              <SettingRow key={provider.id} title={provider.name} helper={provider.dataUse ?? ''} />
            ))}
          <SettingRow
            title="Log retention"
            helper="Choose how long local activity stays available."
          >
            <Select
              label="Log retention"
              value={logRetention}
              onValueChange={(value) => {
                setLogRetention(value);
                localStorage.setItem('ferry.logRetention', value);
              }}
              options={[
                { value: '7', label: '7 days' },
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
                { value: 'forever', label: 'Keep until cleared' },
              ]}
            />
          </SettingRow>
          <div className="button-row">
            <Pill
              size="sm"
              onClick={() => {
                toast({
                  kind: 'success',
                  title: 'Export prepared',
                  body: 'Demo data export is ready.',
                });
              }}
            >
              Export data
            </Pill>
            <Pill
              size="sm"
              onClick={() => {
                setConfirm('Delete local data?');
              }}
            >
              Delete local data
            </Pill>
          </div>
        </Group>
      );
    return (
      <Group title="About">
        <div className="about-card">
          <div className="ferry-mark-large">
            <FerryMark variant="icon" size={48} />
          </div>
          <div>
            <strong>Ferry</strong>
            <p>
              Version {info?.version ?? '…'} · {info?.mock ? 'Demo client' : 'Connected'}
            </p>
            <p>This build runs on simulated data. No real models are called.</p>
          </div>
        </div>
        <h3>Notices</h3>
        <div className="notice-list">
          <span>React Bits · MIT + Commons Clause</span>
          <span>lucide · ISC</span>
          <span>simple-icons · CC0</span>
          <span>Inter · OFL</span>
        </div>
      </Group>
    );
  };
  return (
    <section className="canvas settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">PREFERENCES</span>
          <h1>Settings</h1>
          <p>Control how Ferry works across your workspaces.</p>
        </div>
        {section === 'General' && (
          <Pill
            onClick={() => {
              setConfirm('Reset layout?');
              setConfirmAction(() => () => {
                useUI.getState().resetLayout();
                toast({
                  kind: 'success',
                  title: 'Layout reset',
                  body: 'Panel sizes and positions are back to default.',
                });
              });
            }}
            variant="outline"
          >
            Reset layout
          </Pill>
        )}
      </header>
      <main className="settings-content settings-content-framed">{body()}</main>
      <ProviderKeyDialog
        provider={keyProvider}
        open={Boolean(keyProvider)}
        onOpenChange={(open) => {
          if (!open) setKeyProvider(null);
        }}
      />
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm('');
            setConfirmAction(null);
          }
        }}
        title={confirm}
        description="Review this change before confirming."
      >
        <div className="button-row dialog-actions">
          <Pill
            onClick={() => {
              setConfirm('');
              setConfirmAction(null);
            }}
          >
            Cancel
          </Pill>
          <Pill
            variant="blue-tint"
            onClick={() => {
              setConfirm('');
              const action = confirmAction;
              setConfirmAction(null);
              if (action) void action();
              else
                toast({
                  kind: 'success',
                  title: 'Local data cleared',
                  body: 'Demo data remains available after refresh.',
                });
            }}
          >
            Confirm
          </Pill>
        </div>
      </Dialog>
      <Dialog
        open={addMcp}
        onOpenChange={setAddMcp}
        title="Add MCP server"
        description="Add a local command or remote server URL. This demo records the setup request only."
      >
        <div className="dialog-form">
          <TextField label="Name" value={mcpName} onChange={setMcpName} placeholder="Local tools" />
          <TextField
            label="Command or URL"
            value={mcpAddress}
            onChange={setMcpAddress}
            placeholder="npx server or https://…"
          />
          <div className="button-row dialog-actions">
            <Pill
              onClick={() => {
                setAddMcp(false);
              }}
            >
              Cancel
            </Pill>
            <Pill
              variant="blue-tint"
              onClick={() => {
                setAddMcp(false);
                toast({
                  kind: 'info',
                  title: 'MCP server request saved',
                  body: mcpName || mcpAddress || 'Demo server',
                });
                setMcpName('');
                setMcpAddress('');
              }}
            >
              Add server
            </Pill>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-group-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function SettingRow({
  title,
  helper,
  children,
}: {
  title: string;
  helper: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <small>{helper}</small>
      </div>
      {children}
    </div>
  );
}
function PermissionsContent({ mode, onMode }: { mode: string; onMode: (value: string) => void }) {
  const [rules, setRules] = useState(() => {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem('ferry.permissionRules') ??
          '[{"effect":"ask","pattern":"run_command","tool":"run_command"}]',
      );
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPermissionRule);
    } catch {
      return [];
    }
  });
  const persist = (next: typeof rules) => {
    setRules(next);
    localStorage.setItem('ferry.permissionRules', JSON.stringify(next));
  };
  return (
    <Group title="Permissions">
      <SettingRow title="Default mode" helper="Rules apply in order for matching tools.">
        <SegmentedControl
          label="Permission mode"
          value={mode}
          onValueChange={onMode}
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'auto_edit', label: 'Auto-edit' },
            { value: 'full_auto', label: 'Full auto' },
          ]}
        />
      </SettingRow>
      <h3>Rules</h3>
      {rules.map((rule, index) => (
        <div className="rule-row" key={index}>
          <Select
            label="Rule effect"
            value={rule.effect}
            onValueChange={(value) => {
              persist(rules.map((item, i) => (i === index ? { ...item, effect: value } : item)));
            }}
            options={['allow', 'ask', 'deny'].map((value) => ({ value, label: value }))}
          />
          <input
            aria-label="Rule pattern"
            value={rule.pattern}
            onChange={(event) => {
              persist(
                rules.map((item, i) =>
                  i === index ? { ...item, pattern: event.target.value } : item,
                ),
              );
            }}
          />
          <Select
            label="Rule tool"
            value={rule.tool}
            onValueChange={(value) => {
              persist(rules.map((item, i) => (i === index ? { ...item, tool: value } : item)));
            }}
            options={['run_command', 'read_file', 'edit_file', 'write_file', 'delegate', 'mcp'].map(
              (value) => ({ value, label: value }),
            )}
          />
          <button
            className="quiet-icon"
            aria-label="Remove rule"
            onClick={() => {
              persist(rules.filter((_, i) => i !== index));
            }}
          >
            ×
          </button>
        </div>
      ))}
      <Pill
        size="sm"
        onClick={() => {
          persist([...rules, { effect: 'ask', pattern: '*', tool: 'run_command' }]);
        }}
      >
        Add rule
      </Pill>
    </Group>
  );
}

function DeveloperSettings({
  mockLatency,
  injectErrors,
  update,
}: {
  mockLatency: boolean;
  injectErrors: boolean;
  update: (patch: { mockLatency?: boolean; injectErrors?: boolean }) => void;
}) {
  const [simulateOffline, setSimulateOffline] = useState(
    () => localStorage.getItem('ferry.simulateOffline') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('ferry.simulateOffline', String(simulateOffline));
    window.dispatchEvent(new Event('ferry:offline-change'));
  }, [simulateOffline]);
  return (
    <Group title="Developer">
      <SettingRow title="Mock latency" helper="Add realistic delays to simulated responses.">
        <Switch
          label="Mock latency"
          checked={mockLatency}
          onCheckedChange={(value) => {
            update({ mockLatency: value });
          }}
        />
      </SettingRow>
      <SettingRow title="Inject errors" helper="Exercise recovery states in the mock client.">
        <Switch
          label="Inject errors"
          checked={injectErrors}
          onCheckedChange={(value) => {
            update({ injectErrors: value });
          }}
        />
      </SettingRow>
      <SettingRow title="Simulate offline" helper="Show the saved demo data state.">
        <Switch
          label="Simulate offline"
          checked={simulateOffline}
          onCheckedChange={setSimulateOffline}
        />
      </SettingRow>
    </Group>
  );
}
