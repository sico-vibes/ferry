import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useFerryClient } from '../data/client';
import { listAllModels } from '@ferry/client';
import { keys, useProfiles, useSettings } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import {
  Checkbox,
  Dialog,
  FerryMark,
  UiV2,
  Section,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  PageHeader,
} from '@ferry/ui';
import { FERRY_DOMAINS } from '@ferry/shared';
import type { Profile, Provider, StepKind, Tier } from '@ferry/shared';
import type { RoutingSettings } from '@ferry/shared';
import type { UpdateSnapshot } from '../../main/update-state.js';
import { Eye, EyeOff, Info } from 'lucide-react';
import { ProviderKeyDialog } from './ProviderKeyDialog';
import { OAuthProviderRows } from './OAuthProviderRows';
import { saveKeybindings, useKeybindings } from '../state/keybindings';
import type { SettingsSection } from '../state/ui.types';
const stepKinds: StepKind[] = ['plan', 'edit', 'search', 'summarize', 'review', 'long_context'];
const settingsSections: SettingsSection[] = [
  'General',
  'Profiles',
  'Providers & keys',
  'Routing',
  'Optimizers',
  'Delegation',
  'Permissions',
  'Gateway',
  'Data & privacy',
  'Shortcuts',
  'About',
];
const settingsPageCopy: Record<string, { title: string; description: string }> = {
  General: { title: 'General', description: 'Set the way Ferry looks and behaves.' },
  Profiles: {
    title: 'Profiles',
    description: 'Choose the models and limits Ferry uses for each kind of work.',
  },
  'Providers & keys': {
    title: 'Providers & keys',
    description: 'Connect providers and review their access and data use.',
  },
  Gateway: {
    title: 'Gateway',
    description: 'Connect coding tools to Ferry’s local OpenAI and Anthropic compatible API.',
  },
  Routing: { title: 'Routing', description: 'Choose how Ferry selects models and manages limits.' },
  Optimizers: {
    title: 'Optimizers',
    description: 'Choose how Ferry keeps context focused during longer runs.',
  },
  Delegation: {
    title: 'Delegation',
    description: 'Set when Ferry can hand work to another coding agent.',
  },
  Permissions: {
    title: 'Permissions',
    description: 'Control which workspace actions Ferry can take.',
  },
  Shortcuts: { title: 'Shortcuts', description: 'Review and edit Ferry keyboard shortcuts.' },
  'Data & privacy': {
    title: 'Data & privacy',
    description: 'Review local storage and provider data handling.',
  },
  About: { title: 'About', description: 'Ferry version and project information.' },
};
const stepLabels: Record<StepKind, string> = {
  plan: 'Plan',
  edit: 'Edit',
  search: 'Search',
  summarize: 'Summarize',
  review: 'Review',
  long_context: 'Long context',
};
const routingRows: {
  key: keyof Pick<
    RoutingSettings,
    | 'stickySessions'
    | 'smartReliability'
    | 'textToolFallbackEnabled'
    | 'quotaReservations'
    | 'cooldownReasons'
    | 'gentleQuotaRamp'
    | 'toolRejectionMemory'
    | 'carefulModelRetirement'
  >;
  title: string;
  helper: string;
  info: string;
}[] = [
  {
    key: 'stickySessions',
    title: 'Sticky sessions',
    helper: 'Keep a chat on the same model for 30 minutes so answers stay consistent.',
    info: 'Trade-off: conversations may stay on a model that is no longer the top-scoring choice. Ferry switches when it fails, cools down, or cannot fit the request.',
  },
  {
    key: 'smartReliability',
    title: 'Smart reliability',
    helper: 'Prefer models that have been working lately; old failures fade over time.',
    info: 'Trade-off: Thompson sampling explores uncertain models, so a less-proven model may occasionally be chosen.',
  },
  {
    key: 'textToolFallbackEnabled',
    title: 'Text tool-call fallback',
    helper: 'Allow XML and ReAct tool formats when a text fallback adapter is available.',
    info: 'This only enables routing eligibility; the fallback adapter is supplied separately.',
  },
  {
    key: 'quotaReservations',
    title: 'Quota reservations',
    helper:
      "Reserve capacity before sending so parallel tasks don't overshoot a provider's limits.",
    info: 'Trade-off: estimated tokens are reserved briefly while a request is in flight.',
  },
  {
    key: 'cooldownReasons',
    title: 'Cooldown reasons',
    helper: 'Remember why a provider paused and re-check early only when the pause was a guess.',
    info: 'Trade-off: early probes can use a request; authoritative limits are never probed early.',
  },
  {
    key: 'gentleQuotaRamp',
    title: 'Gentle quota ramp',
    helper:
      'Gradually use a provider less as its free quota runs low, instead of stopping suddenly.',
    info: 'Trade-off: capacity is spread across the remaining quota window.',
  },
  {
    key: 'toolRejectionMemory',
    title: 'Tool-rejection memory',
    helper: 'Temporarily avoid models that keep rejecting tool calls.',
    info: 'Trade-off: a model that later recovers may be used less for up to six hours.',
  },
  {
    key: 'carefulModelRetirement',
    title: 'Careful model retirement',
    helper: "Only retire a model after it fails twice, unless the provider says it's gone.",
    info: 'Trade-off: a genuinely removed model may take a second independent failure to retire.',
  },
];

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

function SettingsInput({
  label,
  value,
  onChange,
  helper,
  error,
  masked = false,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
  error?: string;
  masked?: boolean;
  placeholder?: string;
  type?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <label className="v2-settings-field">
      <span>{label}</span>
      <span className="v2-settings-input-wrap">
        <UiV2.Input
          type={masked && !shown ? 'password' : type}
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          aria-invalid={Boolean(error)}
        />
        {masked && (
          <UiV2.Button
            size="icon"
            variant="ghost"
            aria-label={shown ? 'Hide value' : 'Show value'}
            onClick={() => {
              setShown(!shown);
            }}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </UiV2.Button>
        )}
      </span>
      {error ? (
        <small className="text-destructive">{error}</small>
      ) : helper ? (
        <small className="text-muted-foreground">{helper}</small>
      ) : null}
    </label>
  );
}
export function SettingsCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const toast = useToasts((state) => state.push);
  const keybindings = useKeybindings();
  const [keybindingsDraft, setKeybindingsDraft] = useState(keybindings.content);
  useEffect(() => {
    setKeybindingsDraft(keybindings.content);
  }, [keybindings.content]);
  const section = useUI((state) => state.settingsSection);
  const [confirm, setConfirm] = useState('');
  const [confirmAction, setConfirmAction] = useState<(() => void | Promise<void>) | null>(null);
  const [keyProvider, setKeyProvider] = useState<(typeof providers)[number] | null>(null);
  const [addMcp, setAddMcp] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpAddress, setMcpAddress] = useState('');
  const [gatewayName, setGatewayName] = useState('');
  const [gatewayProfile, setGatewayProfile] = useState('auto-free');
  const [gatewaySecret, setGatewaySecret] = useState('');
  const [gatewayKeyDrafts, setGatewayKeyDrafts] = useState<
    Record<string, { allowedModels: string; rateLimit: string; profile: string }>
  >({});
  const [benchmarkMode, setBenchmarkMode] = useState(
    () => localStorage.getItem('ferry.benchmarkMode') === 'true',
  );
  const [logRetention, setLogRetention] = useState(
    () => localStorage.getItem('ferry.logRetention') ?? '30',
  );
  const [updateState, setUpdateState] = useState<UpdateSnapshot>({
    status: 'idle',
    version: null,
    error: null,
    autoDownload: true,
  });
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  useEffect(() => {
    if (section !== 'About' || !window.ferryHost) return;
    let active = true;
    void window.ferryHost.getUpdateState().then((state) => {
      if (active) setUpdateState(state);
    });
    const off = window.ferryHost.onUpdateState((state) => {
      setUpdateState(state);
    });
    return () => {
      active = false;
      off();
    };
  }, [section]);
  const { data: settingsData } = useSettings();
  const [pendingBySection, setPendingBySection] = useState<
    Partial<Record<SettingsSection, Parameters<typeof client.settings.update>[0]>>
  >({});
  const pendingSettings = pendingBySection[section];
  const settings = settingsData
    ? {
        ...settingsData,
        ...pendingSettings,
        optimizers: { ...settingsData.optimizers, ...pendingSettings?.optimizers },
        routing: { ...settingsData.routing, ...pendingSettings?.routing },
        paidCaps: { ...settingsData.paidCaps, ...pendingSettings?.paidCaps },
        developer: { ...settingsData.developer, ...pendingSettings?.developer },
      }
    : undefined;
  const { data: profiles = [] } = useProfiles();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: oauthProviders = [] } = useQuery({
    queryKey: ['oauth-providers'],
    queryFn: () => client.oauth.list(),
  });
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => listAllModels(client),
  });
  const { data: lanes = [] } = useQuery({
    queryKey: ['lanes'],
    queryFn: () => client.delegation.lanes(),
  });
  const { data: acpAgents = [] } = useQuery({
    queryKey: ['delegation', 'detected-agents'],
    queryFn: () => client.delegation.detectAgents(),
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
  const appVersion = (window.ferryHost?.versions as { app?: string } | undefined)?.app;
  const gatewayQuery = useQuery({
    queryKey: ['gateway-settings'],
    queryFn: () => client.gateway.settings(),
    enabled: section === 'Gateway',
  });
  const gatewayKeysQuery = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
    enabled: section === 'Gateway',
  });
  const gateway = gatewayQuery.data;
  const gatewayStatus = gateway?.status;
  const gatewayPort = gateway?.port ?? 11435;
  const gatewayHost = gatewayStatus?.url ?? `http://127.0.0.1:${String(gatewayPort)}`;
  const updateGateway = async (
    patch: Partial<{ enabled: boolean; port: number; allowLan: boolean }>,
  ) => {
    if (!gateway) return;
    const enablingLan = patch.allowLan === true && !gateway.allowLan;
    if (
      enablingLan &&
      !window.confirm(
        'Allow other devices on your local network to connect to Ferry? Only continue on a trusted network.',
      )
    )
      return;
    await client.gateway.setSettings({
      enabled: gateway.enabled,
      port: gateway.port,
      allowLan: gateway.allowLan,
      ...patch,
      ...(enablingLan ? { confirmLan: true } : {}),
    });
    await cache.invalidateQueries({ queryKey: ['gateway-settings'] });
  };
  const createGatewayKey = async () => {
    if (!gatewayName.trim()) return;
    const created = await client.gateway.createKey({
      name: gatewayName.trim(),
      profile: gatewayProfile,
    });
    setGatewaySecret(created.secret);
    setGatewayName('');
    await cache.invalidateQueries({ queryKey: ['gateway-keys'] });
  };
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const fallbackChain = profileDraft?.fallbackChain ?? [];
  const [chainDragIndex, setChainDragIndex] = useState<number | null>(null);
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
  const update = (patch: Parameters<typeof client.settings.update>[0]) => {
    setPendingBySection((current) => {
      const previous = current[section] ?? {};
      return {
        ...current,
        [section]: {
          ...previous,
          ...patch,
          ...(patch.optimizers
            ? { optimizers: { ...previous.optimizers, ...patch.optimizers } }
            : {}),
          ...(patch.routing ? { routing: { ...previous.routing, ...patch.routing } } : {}),
          ...(patch.paidCaps ? { paidCaps: { ...previous.paidCaps, ...patch.paidCaps } } : {}),
          ...(patch.developer ? { developer: { ...previous.developer, ...patch.developer } } : {}),
        },
      };
    });
    return Promise.resolve();
  };
  const saveSettings = async () => {
    if (!pendingSettings) return;
    try {
      await client.settings.update(pendingSettings);
      await cache.invalidateQueries({ queryKey: keys.settings });
      setPendingBySection((current) => {
        const next = { ...current };
        Reflect.deleteProperty(next, section);
        return next;
      });
      toast({ kind: 'success', title: 'Settings saved', body: null });
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Settings could not be saved',
        body: error instanceof Error ? error.message : String(error),
      });
    }
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
    toast({ kind: 'success', title: `Profile saved: ${profileDraft.name}`, body: null });
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
    if (section === 'General' || section === 'Shortcuts')
      return (
        <>
          {section === 'General' && (
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
              <SettingRow title="First run" helper="Review the provider and workspace setup again.">
                <UiV2.Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    localStorage.removeItem('ferry.onboardingStep');
                    void client.settings
                      .update({ onboardingComplete: false })
                      .then(() => cache.invalidateQueries({ queryKey: keys.settings }))
                      .then(() => navigate({ to: '/onboarding' }));
                  }}
                >
                  Run onboarding again
                </UiV2.Button>
              </SettingRow>
            </Group>
          )}
          <Group title="Keyboard shortcuts">
            <p className="muted">
              Edit keybindings.json in Ferry's config folder. Changes reload automatically.
            </p>
            {keybindings.errors.map((error) => (
              <p className="text-meta text-warn" key={error}>
                {error}
              </p>
            ))}
            <label className="grid gap-2 text-label" htmlFor="keybindings-json">
              keybindings.json
            </label>
            <textarea
              id="keybindings-json"
              className="w-full min-h-36 rounded-control border border-line bg-panel p-3 font-mono text-meta text-text-1"
              value={keybindingsDraft}
              onChange={(event) => {
                setKeybindingsDraft(event.target.value);
              }}
            />
            {keybindingsDraft !== keybindings.content && (
              <UiV2.Button
                size="sm"
                onClick={() => {
                  saveKeybindings(keybindingsDraft)
                    .then((errors) => {
                      if (errors.length)
                        toast({
                          kind: 'error',
                          title: 'Keybindings validation failed',
                          body: errors.join('; '),
                        });
                      else toast({ kind: 'success', title: 'Keybindings saved', body: null });
                    })
                    .catch((error: unknown) => {
                      toast({
                        kind: 'error',
                        title: 'Could not save keybindings',
                        body: error instanceof Error ? error.message : String(error),
                      });
                    });
                }}
              >
                Save changes
              </UiV2.Button>
            )}
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
            <UiV2.Button
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
            </UiV2.Button>
          </div>
          {profileDraft ? (
            <div className="profile-editor">
              <div className="group-title">
                <div>
                  <h2>{profileDraft.name}</h2>
                  <p>Edit routing and spending limits.</p>
                </div>
                <div className="button-row">
                  <UiV2.Button
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
                  </UiV2.Button>
                  <UiV2.Button
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
                  </UiV2.Button>
                  {(!profiles.find((item) => item.id === profileDraft.id) ||
                    JSON.stringify(profileDraft) !==
                      JSON.stringify(profiles.find((item) => item.id === profileDraft.id))) && (
                    <UiV2.Button size="sm" variant="default" onClick={() => void saveProfile()}>
                      Save changes
                    </UiV2.Button>
                  )}
                </div>
              </div>
              <div className="form-grid">
                <SettingsInput
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
                <SettingsInput
                  label="Description"
                  value={profileDraft.description}
                  onChange={(value) => {
                    mutateProfile('description', value);
                  }}
                />
              </div>
              <h3>Planner/editor split</h3>
              <SettingRow
                title="Separate planning and editing"
                helper="A planner writes a file-by-file edit plan. An editor applies it with its own tool format."
              >
                <Switch
                  label="Planner/editor split"
                  checked={profileDraft.roles.enabled}
                  onCheckedChange={(enabled) => {
                    mutateProfile('roles', { ...profileDraft.roles, enabled });
                  }}
                />
              </SettingRow>
              {profileDraft.roles.enabled && (
                <div className="form-grid">
                  {(['plannerModelRef', 'editorModelRef'] as const).map((key) => (
                    <Select
                      key={key}
                      label={key === 'plannerModelRef' ? 'Planner model' : 'Editor model'}
                      value={profileDraft.roles[key] ?? 'auto'}
                      onValueChange={(value) => {
                        mutateProfile('roles', {
                          ...profileDraft.roles,
                          [key]: value === 'auto' ? null : value,
                        });
                      }}
                      options={[
                        { value: 'auto', label: 'Auto' },
                        ...models.map((model) => ({ value: model.ref, label: model.name })),
                      ]}
                    />
                  ))}
                </div>
              )}
              <h3>Fallback order</h3>
              <p className="muted">
                Drag providers to reorder them. Ferry uses the first live, tool-capable model and
                then tries scored eligible models.
              </p>
              {profileDraft.fallbackChain === undefined ? (
                <UiV2.Button
                  size="sm"
                  onClick={() => {
                    mutateProfile('fallbackChain', []);
                  }}
                >
                  Add fallback order
                </UiV2.Button>
              ) : (
                <>
                  <div className="profile-chain-list">
                    {profileDraft.fallbackChain.map((entry, index) => (
                      <div
                        key={`${entry.provider}-${String(index)}`}
                        className="profile-chain-row"
                        draggable
                        onDragStart={() => {
                          setChainDragIndex(index);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                        }}
                        onDrop={() => {
                          if (chainDragIndex === null || chainDragIndex === index) return;
                          const next = [...fallbackChain];
                          const [moved] = next.splice(chainDragIndex, 1);
                          if (moved) next.splice(index, 0, moved);
                          mutateProfile('fallbackChain', next);
                          setChainDragIndex(null);
                        }}
                        onDragEnd={() => {
                          setChainDragIndex(null);
                        }}
                      >
                        <Select
                          label={`Provider ${String(index + 1)}`}
                          value={entry.provider}
                          onValueChange={(value) => {
                            const next = [...fallbackChain];
                            next[index] = { ...entry, provider: value as Provider['id'] };
                            mutateProfile('fallbackChain', next);
                          }}
                          options={providers.map((provider) => ({
                            value: provider.id,
                            label: provider.name,
                          }))}
                        />
                        <div className="profile-chain-patterns">
                          {entry.patterns.map((pattern, patternIndex) => (
                            <div className="button-row" key={`${pattern}-${String(patternIndex)}`}>
                              <SettingsInput
                                label={`Model pattern ${String(patternIndex + 1)}`}
                                value={pattern}
                                onChange={(value) => {
                                  const next = [...fallbackChain];
                                  const patterns = [...entry.patterns];
                                  patterns[patternIndex] = value;
                                  next[index] = { ...entry, patterns };
                                  mutateProfile('fallbackChain', next);
                                }}
                              />
                              <UiV2.Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const next = [...fallbackChain];
                                  next[index] = {
                                    ...entry,
                                    patterns: entry.patterns.filter((_, i) => i !== patternIndex),
                                  };
                                  mutateProfile('fallbackChain', next);
                                }}
                              >
                                Remove
                              </UiV2.Button>
                            </div>
                          ))}
                          <UiV2.Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const next = [...fallbackChain];
                              next[index] = {
                                ...entry,
                                patterns: [...entry.patterns, 'new-model-pattern'],
                              };
                              mutateProfile('fallbackChain', next);
                            }}
                          >
                            Add model pattern
                          </UiV2.Button>
                        </div>
                        <UiV2.Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            mutateProfile(
                              'fallbackChain',
                              fallbackChain.filter((_, i) => i !== index),
                            );
                          }}
                        >
                          Remove provider
                        </UiV2.Button>
                      </div>
                    ))}
                  </div>
                  <UiV2.Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const provider = providers.find(
                        (item) => !fallbackChain.some((entry) => entry.provider === item.id),
                      );
                      if (!provider) return;
                      mutateProfile('fallbackChain', [
                        ...fallbackChain,
                        { provider: provider.id, patterns: ['new-model-pattern'] },
                      ]);
                    }}
                  >
                    Add provider
                  </UiV2.Button>
                </>
              )}
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
              <SettingRow
                title="Paid confirmation"
                helper="Skip the first paid-call prompt only when this profile explicitly pre-authorizes paid models."
              >
                <Switch
                  label="Pre-authorize paid models"
                  checked={profileDraft.paidConfirmation.preauthorize}
                  onCheckedChange={(value) => {
                    mutateProfile('paidConfirmation', {
                      ...profileDraft.paidConfirmation,
                      preauthorize: value,
                    });
                  }}
                />
              </SettingRow>
              <SettingRow
                title="Subscription account calls"
                helper="Ask before using subscription OAuth or CLI account lanes."
              >
                <Switch
                  label="Confirm subscription account calls"
                  checked={profileDraft.paidConfirmation.confirmSubscriptions}
                  onCheckedChange={(value) => {
                    mutateProfile('paidConfirmation', {
                      ...profileDraft.paidConfirmation,
                      confirmSubscriptions: value,
                    });
                  }}
                />
              </SettingRow>
              <SettingRow
                title="Trial and credit calls"
                helper="Ask before using provider trial or credit lanes."
              >
                <Switch
                  label="Confirm trial and credit calls"
                  checked={profileDraft.paidConfirmation.confirmTrials}
                  onCheckedChange={(value) => {
                    mutateProfile('paidConfirmation', {
                      ...profileDraft.paidConfirmation,
                      confirmTrials: value,
                    });
                  }}
                />
              </SettingRow>
              <div className="form-grid">
                <SettingsInput
                  label="Session cap ($)"
                  value={profileDraft.caps.sessionUsd?.toString() ?? ''}
                  placeholder="No cap"
                  onChange={(value) => {
                    mutateProfile('caps', {
                      ...profileDraft.caps,
                      sessionUsd: value ? Number(value) : null,
                    });
                  }}
                />
                <SettingsInput
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
                <SettingsInput
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
    if (section === 'Providers & keys')
      return (
        <Group>
          <p className="muted">
            Keys are stored by the local client. Free tier data use depends on each provider's
            terms.
          </p>
          <p className="muted">
            Avoid multi-account workarounds, shared keys, and web-session proxies. Providers may ban
            accounts or revoke access for these practices; Ferry does not support them.
          </p>
          <div aria-label="Provider keys" className="provider-key-table">
            <div aria-hidden="true" className="provider-key-columns text-meta text-text-3">
              <span>Provider</span>
              <span>Status</span>
              <span>Manage key</span>
              <span>Test</span>
              <span>Enabled</span>
            </div>
            {providers.map((provider) => {
              const status = provider.keyStatus.replace('_', ' ');
              const statusTone =
                provider.keyStatus === 'valid'
                  ? 'ok'
                  : provider.keyStatus === 'invalid'
                    ? 'bad'
                    : provider.keyStatus === 'missing'
                      ? 'pending'
                      : 'neutral';
              const toggleApplicable = provider.tag !== 'subscription_oauth';
              return (
                <div className="provider-key-row" key={provider.id}>
                  <div className="provider-key-description">
                    <strong title={provider.name}>{provider.name}</strong>
                    <small title={provider.termsNote ?? provider.dataUse ?? undefined}>
                      {provider.termsNote ?? provider.dataUse ?? 'No data use note provided.'}
                    </small>
                  </div>
                  <span className={`status-pill ${statusTone}`}>{status}</span>
                  <UiV2.Button
                    size="sm"
                    onClick={() => {
                      setKeyProvider(provider);
                    }}
                  >
                    Manage key
                  </UiV2.Button>
                  <UiV2.Button
                    size="sm"
                    disabled={testingProvider === provider.id || !provider.enabled}
                    variant="outline"
                    onClick={() => void testProvider(provider)}
                  >
                    {testingProvider === provider.id ? 'Testing…' : 'Test'}
                  </UiV2.Button>
                  <span
                    className="provider-key-toggle"
                    title={toggleApplicable ? undefined : 'Manage subscription access in Explore.'}
                  >
                    <Switch
                      label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
                      checked={provider.enabled}
                      disabled={!toggleApplicable}
                      onCheckedChange={(enabled) =>
                        void client.providers
                          .setEnabled(provider.id, enabled)
                          .then(() => cache.invalidateQueries({ queryKey: ['providers'] }))
                      }
                    />
                  </span>
                </div>
              );
            })}
          </div>
          <Section title="Subscription logins" className="mt-4">
            <OAuthProviderRows
              providers={oauthProviders}
              onLogin={() => void navigate({ to: '/models' })}
              onLogout={(provider) =>
                void client.oauth
                  .logout(provider.id)
                  .then(() => cache.invalidateQueries({ queryKey: ['oauth-providers'] }))
              }
            />
          </Section>
          {providers.some((provider) => provider.tag === 'trial') && (
            <>
              <h3>Trial credits</h3>
              <p className="muted">
                Trial providers are excluded from automatic routing until you opt in. Using trial
                credits can consume a limited balance.
              </p>
              {providers
                .filter((provider) => provider.tag === 'trial')
                .map((provider) => {
                  const optedIn =
                    settings?.routing.trialOptInProviders.includes(provider.id) ?? false;
                  return (
                    <SettingRow
                      key={provider.id}
                      title={provider.name}
                      helper="Allow Auto-Free, planner/editor roles, and the gateway to use this provider's trial credits."
                    >
                      <Switch
                        label={`Use trial credits for ${provider.name}`}
                        checked={optedIn}
                        onCheckedChange={(enabled) => {
                          if (!settings) return;
                          const trialOptInProviders = enabled
                            ? [...new Set([...settings.routing.trialOptInProviders, provider.id])]
                            : settings.routing.trialOptInProviders.filter(
                                (id) => id !== provider.id,
                              );
                          void update({
                            routing: { ...settings.routing, trialOptInProviders },
                          });
                        }}
                      />
                    </SettingRow>
                  );
                })}
            </>
          )}
          <SettingRow
            title="Allow subscription OAuth models in routing"
            helper="When off, Auto-Free and Best Available never choose subscription logins. OAuth models remain available for manual selection."
          >
            <Switch
              label="Allow subscription OAuth models in routing"
              checked={settings?.allowSubscriptionOAuthRouting ?? false}
              onCheckedChange={(allowSubscriptionOAuthRouting) =>
                void update({ allowSubscriptionOAuthRouting })
              }
            />
          </SettingRow>
          <UiV2.Button size="sm" variant="outline" onClick={() => void navigate({ to: '/models' })}>
            Open Models
          </UiV2.Button>
        </Group>
      );
    if (section === 'Gateway')
      return (
        <>
          <Group title="Local API gateway">
            <p className="settings-helper">
              Other coding tools send requests to Ferry. Ferry keeps provider credentials local and
              applies your routing, quota, and avoid-training settings.
            </p>
            <SettingRow
              title="Enable Gateway"
              helper="Localhost only by default. LAN access makes this API reachable to other devices on your network."
            >
              <Switch
                label="Enable Gateway"
                checked={gateway?.enabled ?? false}
                onCheckedChange={(enabled) => void updateGateway({ enabled })}
              />
            </SettingRow>
            <SettingRow
              title="Port"
              helper={`Status: ${gatewayStatus?.running ? `Running at ${String(gatewayStatus.url)}` : 'Stopped'}${gatewayStatus?.port && gatewayStatus.port !== gatewayPort ? ` Port ${String(gatewayPort)} was busy; using ${String(gatewayStatus.port)}` : ''}`}
            >
              <SettingsInput
                label="Port"
                value={String(gatewayPort)}
                onChange={(value) => {
                  const port = Number(value);
                  if (Number.isInteger(port) && port >= 0 && port <= 65535)
                    void updateGateway({ port });
                }}
              />
            </SettingRow>
            <SettingRow
              title="Allow LAN connections"
              helper="Binds on all network interfaces. Only enable this on a trusted network, and do not share gateway keys."
            >
              <Switch
                label="Allow LAN connections"
                checked={gateway?.allowLan ?? false}
                onCheckedChange={(allowLan) => void updateGateway({ allowLan })}
              />
            </SettingRow>
            <p className="settings-helper">
              Providers’ free tiers are per person. Don’t share Ferry gateway keys.
            </p>
          </Group>
          <Group title="Create a Ferry key">
            <SettingsInput
              label="Key name"
              value={gatewayName}
              onChange={setGatewayName}
              placeholder="OpenCode on my laptop"
            />
            <Select
              label="Routing profile"
              value={gatewayProfile}
              onValueChange={setGatewayProfile}
              options={[
                { value: 'auto-free', label: 'Auto-Free' },
                { value: 'best', label: 'Best Available' },
                { value: 'fast', label: 'Fast' },
                { value: 'long-context', label: 'Long Context' },
                ...profiles
                  .filter((profile) => !profile.builtin)
                  .map((profile) => ({ value: profile.id, label: profile.name })),
              ]}
            />
            <UiV2.Button disabled={!gatewayName.trim()} onClick={() => void createGatewayKey()}>
              Create key
            </UiV2.Button>
          </Group>
          <Group title="Gateway keys">
            {(gatewayKeysQuery.data ?? []).map((key) => (
              <div className="settings-row" key={key.id}>
                <div>
                  {(() => {
                    const draft = gatewayKeyDrafts[key.id] ?? {
                      allowedModels: key.allowedModels.join(', '),
                      rateLimit: key.rateLimit === null ? '' : String(key.rateLimit),
                      profile: key.profile,
                    };
                    return (
                      <>
                        <strong>{key.name}</strong>
                        <p>
                          {key.profile} · {key.usage.requests} requests ·{' '}
                          {key.lastUsedAt
                            ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                            : 'Never used'}
                        </p>
                        <SettingsInput
                          label="Allowed model IDs (blank means all enabled models)"
                          value={draft.allowedModels}
                          onChange={(value) => {
                            setGatewayKeyDrafts((current) => ({
                              ...current,
                              [key.id]: { ...draft, allowedModels: value },
                            }));
                          }}
                        />
                        <Select
                          label="Routing profile"
                          value={draft.profile}
                          onValueChange={(profile) => {
                            setGatewayKeyDrafts((current) => ({
                              ...current,
                              [key.id]: { ...draft, profile },
                            }));
                          }}
                          options={[
                            { value: 'auto-free', label: 'Auto-Free' },
                            { value: 'best', label: 'Best Available' },
                            { value: 'fast', label: 'Fast' },
                            { value: 'long-context', label: 'Long Context' },
                            ...profiles
                              .filter((profile) => !profile.builtin)
                              .map((profile) => ({ value: profile.id, label: profile.name })),
                          ]}
                        />
                        <SettingsInput
                          label="Requests per minute (blank means unlimited)"
                          value={draft.rateLimit}
                          onChange={(value) => {
                            setGatewayKeyDrafts((current) => ({
                              ...current,
                              [key.id]: { ...draft, rateLimit: value },
                            }));
                          }}
                        />
                        <UiV2.Button
                          onClick={() => {
                            const rateLimit = draft.rateLimit.trim()
                              ? Number(draft.rateLimit)
                              : null;
                            if (
                              rateLimit !== null &&
                              (!Number.isInteger(rateLimit) || rateLimit < 1)
                            )
                              return;
                            const allowedModels = draft.allowedModels
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean);
                            void client.gateway
                              .updateKey({
                                id: key.id,
                                patch: { allowedModels, rateLimit, profile: draft.profile },
                              })
                              .then(() => {
                                setGatewayKeyDrafts((current) => {
                                  const { [key.id]: _removed, ...next } = current;
                                  return next;
                                });
                                return cache.invalidateQueries({ queryKey: ['gateway-keys'] });
                              });
                          }}
                        >
                          Save key settings
                        </UiV2.Button>
                        <Switch
                          label="Compress tool results"
                          checked={key.compressToolResults}
                          onCheckedChange={(compressToolResults) =>
                            void client.gateway
                              .updateKey({ id: key.id, patch: { compressToolResults } })
                              .then(() => cache.invalidateQueries({ queryKey: ['gateway-keys'] }))
                          }
                        />
                        <Switch
                          label="Terse system prompt"
                          checked={key.terseSystemPrompt}
                          onCheckedChange={(terseSystemPrompt) =>
                            void client.gateway
                              .updateKey({ id: key.id, patch: { terseSystemPrompt } })
                              .then(() => cache.invalidateQueries({ queryKey: ['gateway-keys'] }))
                          }
                        />
                      </>
                    );
                  })()}
                </div>
                {!key.revokedAt && (
                  <UiV2.Button
                    variant="outline"
                    onClick={() =>
                      void client.gateway
                        .revokeKey(key.id)
                        .then(() => cache.invalidateQueries({ queryKey: ['gateway-keys'] }))
                    }
                  >
                    Revoke
                  </UiV2.Button>
                )}
              </div>
            ))}
            {gatewayKeysQuery.data?.length === 0 && (
              <p className="settings-helper">No gateway keys yet.</p>
            )}
          </Group>
          <Group title="Client setup">
            <pre>
              {JSON.stringify(
                {
                  $schema: 'https://opencode.ai/config.json',
                  provider: {
                    ferry: {
                      npm: '@ai-sdk/openai-compatible',
                      name: 'Ferry',
                      options: { baseURL: `${gatewayHost}/v1`, apiKey: 'YOUR_FERRY_GATEWAY_KEY' },
                      models: Object.fromEntries(
                        [
                          'ferry/auto-free',
                          'ferry/best',
                          'ferry/fast',
                          'ferry/long-context',
                          ...models.map((model) => model.ref),
                        ].map((id) => [id, { name: id }]),
                      ),
                    },
                  },
                },
                null,
                2,
              )}
            </pre>
            <pre>{`Aider (PowerShell):\n$env:OPENAI_API_BASE = '${gatewayHost}/v1'\n$env:OPENAI_API_KEY = 'YOUR_FERRY_GATEWAY_KEY'\naider --model ferry/auto-free`}</pre>
            <pre>{`Cline / Roo Code / Kilo: choose OpenAI Compatible, then set Base URL ${gatewayHost}/v1, API key YOUR_FERRY_GATEWAY_KEY, and model ferry/auto-free.\n\nContinue config.yaml:\nmodels:\n  - name: Ferry Auto-Free\n    provider: openai\n    model: ferry/auto-free\n    apiBase: ${gatewayHost}/v1\n    apiKey: YOUR_FERRY_GATEWAY_KEY`}</pre>
            <pre>{`Claude Code (PowerShell):\n$env:ANTHROPIC_BASE_URL = '${gatewayHost}'\n$env:ANTHROPIC_AUTH_TOKEN = 'YOUR_FERRY_GATEWAY_KEY'\nclaude`}</pre>
          </Group>
        </>
      );
    if (section === 'Routing')
      return (
        <>
          <Group title="Paid spending caps">
            <p className="muted">
              Global limits apply across every profile. Profile limits can make these stricter.
            </p>
            <div className="form-grid">
              <SettingsInput
                label="Global session cap ($)"
                value={settings?.paidCaps.sessionUsd?.toString() ?? ''}
                placeholder="No cap"
                onChange={(value) =>
                  settings &&
                  void update({
                    paidCaps: { ...settings.paidCaps, sessionUsd: value ? Number(value) : null },
                  })
                }
              />
              <SettingsInput
                label="Global daily cap ($)"
                value={settings?.paidCaps.dailyUsd?.toString() ?? ''}
                placeholder="No cap"
                onChange={(value) =>
                  settings &&
                  void update({
                    paidCaps: { ...settings.paidCaps, dailyUsd: value ? Number(value) : null },
                  })
                }
              />
              <SettingsInput
                label="Global monthly cap ($)"
                value={settings?.paidCaps.monthlyUsd?.toString() ?? ''}
                placeholder="No cap"
                onChange={(value) =>
                  settings &&
                  void update({
                    paidCaps: { ...settings.paidCaps, monthlyUsd: value ? Number(value) : null },
                  })
                }
              />
            </div>
          </Group>
          <Group title="Routing behavior">
            <SettingRow
              title="Planner/editor roles"
              helper="Role model selection uses catalog quality priors, context fit, tool support, and observed reliability."
            >
              <span className="muted">Configure per profile</span>
            </SettingRow>
            <SettingRow
              title="Benchmark quality weight"
              helper="Give published coding and tool-use scores more or less influence. Models without scores remain neutral."
            >
              <div className="range-control">
                <Slider
                  label="Benchmark quality weight"
                  min={0}
                  max={12}
                  step={1}
                  value={settings?.routing.qualityWeight ?? 4}
                  onValueChange={(value) =>
                    settings &&
                    void update({ routing: { ...settings.routing, qualityWeight: value } })
                  }
                />
                <span>{settings?.routing.qualityWeight ?? 4}</span>
              </div>
            </SettingRow>
            <SettingRow
              title="Tool-call repair for weaker models"
              helper="Automatically recover tool calls written as text when native tool calling is unreliable."
            >
              <Switch
                label="Tool-call repair for weaker models"
                checked={settings?.toolCallRepair ?? true}
                onCheckedChange={(toolCallRepair) => void update({ toolCallRepair })}
              />
            </SettingRow>
          </Group>
          <Group title="Routing">
            <p className="muted">
              Choose how Ferry balances continuity, reliability, and provider capacity.
            </p>
            {routingRows.map((row) => (
              <SettingRow key={row.key} title={row.title} helper={row.helper}>
                <div className="inline-control">
                  <span
                    className="routing-info"
                    role="img"
                    title={row.info}
                    aria-label={`${row.title} trade-off`}
                  >
                    <Info size={15} />
                  </span>
                  <Switch
                    label={row.title}
                    checked={settings?.routing[row.key] ?? true}
                    onCheckedChange={(value) => {
                      if (settings)
                        void update({ routing: { ...settings.routing, [row.key]: value } });
                    }}
                  />
                </div>
              </SettingRow>
            ))}
            <details className="routing-tune">
              <summary>Tune</summary>
              <SettingRow
                title="Sticky session TTL"
                helper="How long a conversation keeps its selected model."
              >
                <div className="range-control">
                  <Slider
                    label="Sticky session TTL in minutes"
                    min={1}
                    max={120}
                    step={1}
                    value={settings?.routing.stickyTtlMinutes ?? 30}
                    onValueChange={(value) =>
                      settings &&
                      void update({
                        routing: { ...settings.routing, stickyTtlMinutes: Math.round(value) },
                      })
                    }
                  />
                  <span>{settings?.routing.stickyTtlMinutes ?? 30} min</span>
                </div>
              </SettingRow>
              <SettingRow
                title="Ramp start"
                helper="Begin gradual demotion below this fraction of quota remaining."
              >
                <div className="range-control">
                  <Slider
                    label="Quota ramp start"
                    min={0.05}
                    max={0.5}
                    step={0.01}
                    value={settings?.routing.rampStart ?? 0.2}
                    onValueChange={(value) =>
                      settings &&
                      void update({ routing: { ...settings.routing, rampStart: value } })
                    }
                  />
                  <span>{Math.round((settings?.routing.rampStart ?? 0.2) * 100)}%</span>
                </div>
              </SettingRow>
              <SettingRow
                title="Ramp floor"
                helper="Keep at least this routing score while quota is low."
              >
                <div className="range-control">
                  <Slider
                    label="Quota ramp floor"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={settings?.routing.rampFloor ?? 0.1}
                    onValueChange={(value) =>
                      settings &&
                      void update({ routing: { ...settings.routing, rampFloor: value } })
                    }
                  />
                  <span>{Math.round((settings?.routing.rampFloor ?? 0.1) * 100)}%</span>
                </div>
              </SettingRow>
              <UiV2.Button
                size="sm"
                variant="outline"
                onClick={() =>
                  settings &&
                  void update({
                    routing: {
                      ...settings.routing,
                      stickyTtlMinutes: 30,
                      qualityWeight: 4,
                      rampStart: 0.2,
                      rampFloor: 0.1,
                    },
                  })
                }
              >
                Reset tune defaults
              </UiV2.Button>
            </details>
          </Group>
        </>
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
            {!optimizerStats || optimizerStats.demo ? (
              <>
                <strong>No optimizer measurements yet</strong>
                <span>Only recorded token counts appear here.</span>
              </>
            ) : (
              <>
                <strong>
                  {optimizerStats.today.savedTokens.toLocaleString()} measured tokens saved today
                </strong>
                <span>
                  {optimizerStats.today.percent}% · {optimizerStats.today.samples} recorded events
                </span>
              </>
            )}
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
          {lanes.some((lane) => lane.implementer === 'opencode' && !lane.model?.trim()) && (
            <p className="muted" role="status">
              Choose a model for the OpenCode lane in its lane configuration, or set a default model
              in your OpenCode config. Delegation cannot start without one.
            </p>
          )}
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
          <h3>ACP agent detection</h3>
          <p className="muted">
            Ferry checks PATH and the version command. Pi credentials remain managed by Pi.
          </p>
          {acpAgents.map((agent) => {
            const configured = lanes.some(
              (lane) => lane.implementer === 'acp' && lane.agent === agent.id,
            );
            return (
              <div className="lane-row" key={agent.id}>
                <strong>{agent.name}</strong>
                <small>
                  {agent.available
                    ? `${agent.version ?? agent.executable ?? agent.command}${configured ? ' · Configured in a lane' : ''}`
                    : agent.installHint}
                </small>
                <span className={`status-pill ${agent.available ? 'ok' : 'pending'}`}>
                  {agent.available ? 'Installed' : 'Not installed'}
                </span>
                {agent.verified && (
                  <span className="status-pill ok">Verified · {agent.verifiedAt}</span>
                )}
                {agent.caution && (
                  <span className="status-pill pending" title={agent.cautionNote ?? undefined}>
                    {agent.cautionNote ?? 'Use caution'}
                  </span>
                )}
              </div>
            );
          })}
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
    if (section === 'Data & privacy')
      return (
        <>
          <Group title="Data use and retention">
            <p className="muted">
              Provider data practices vary by plan and endpoint. Review each provider's terms before
              adding a key.
            </p>
            <SettingRow
              title="Avoid providers that train on my prompts"
              helper="Off by default. When enabled, Auto routing skips providers whose catalog data says prompts may be used for training or service improvement."
            >
              <Switch
                label="Avoid providers that train on my prompts"
                checked={settings?.routing.avoidTrainingProviders ?? false}
                onCheckedChange={(avoidTrainingProviders) =>
                  settings &&
                  void update({
                    routing: { ...settings.routing, avoidTrainingProviders },
                  })
                }
              />
            </SettingRow>
            {providers
              .filter((provider) => provider.dataUse)
              .map((provider) => (
                <SettingRow
                  key={provider.id}
                  title={provider.name}
                  helper={provider.dataUse ?? ''}
                />
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
              <UiV2.Button
                size="sm"
                onClick={() => {
                  toast({
                    kind: 'success',
                    title: 'Export prepared',
                    body: 'Export is ready.',
                  });
                }}
              >
                Export data
              </UiV2.Button>
              <UiV2.Button
                size="sm"
                onClick={() => {
                  setConfirm('Delete local data?');
                }}
              >
                Delete local data
              </UiV2.Button>
            </div>
          </Group>
          <Group title="Integrations">
            <p className="muted">Connect local tools through Model Context Protocol.</p>
            {mcps.map((server) => (
              <SettingRow
                key={server.id}
                title={server.name}
                helper={`${server.transport} - ${String(server.toolCount)} tools`}
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
            <UiV2.Button
              size="sm"
              onClick={() => {
                setAddMcp(true);
              }}
            >
              Add server
            </UiV2.Button>
          </Group>
          <Group title="Local workflows">
            <p className="muted">Enable local instructions and reusable workflows.</p>
            {skills.map((skill) => (
              <SettingRow key={skill.id} title={skill.name} helper={skill.description}>
                <Switch
                  label={skill.name}
                  checked={skill.enabled}
                  onCheckedChange={(value) => void toggleSkill(skill.id, value)}
                />
              </SettingRow>
            ))}
          </Group>
        </>
      );
    return (
      <>
        <details className="settings-developer-details">
          <summary>Developer diagnostics</summary>
          <DeveloperSettings
            providerHealth={providers}
            mockLatency={settings?.developer.mockLatency ?? false}
            injectErrors={settings?.developer.injectErrors ?? false}
            realDomains={settings?.developer.realDomains ?? []}
            availableDomains={window.ferryEngineHello?.realDomains ?? []}
            update={(patch) =>
              void update({
                developer: {
                  showReferenceOverlay: settings?.developer.showReferenceOverlay ?? false,
                  mockLatency: patch.mockLatency ?? settings?.developer.mockLatency ?? false,
                  injectErrors: patch.injectErrors ?? settings?.developer.injectErrors ?? false,
                  realDomains: patch.realDomains ?? settings?.developer.realDomains ?? [],
                },
              })
            }
          />
        </details>
        <Group title="About Ferry">
          <div className="about-card">
            <div className="ferry-mark-large">
              <FerryMark variant="icon" size={48} />
            </div>
            <div>
              <strong>Ferry</strong>
              <p>Version {appVersion ?? info?.version ?? 'unknown'}</p>
              <p>
                Channel {window.ferryHost?.channel ?? 'beta'} · Commit{' '}
                {window.ferryHost?.commit ?? 'unknown'}
              </p>
            </div>
          </div>
          {window.ferryHost && (
            <>
              <SettingRow
                title="Update channel"
                helper="Beta receives the latest pre-release builds. Stable will be available after its first release."
              >
                <SegmentedControl
                  label="Update channel"
                  value={window.ferryHost.channel}
                  onValueChange={() => undefined}
                  options={[
                    { value: 'beta', label: 'Beta' },
                    { value: 'stable', label: 'Stable', disabled: true },
                  ]}
                />
              </SettingRow>
              <SettingRow
                title="Automatic downloads"
                helper="Download updates when they are available. Restart Ferry to finish installing."
              >
                <Switch
                  label="Automatically download updates"
                  checked={updateState.autoDownload}
                  onCheckedChange={(enabled) => {
                    void window.ferryHost?.setAutoDownload(enabled).then(setUpdateState);
                  }}
                />
              </SettingRow>
              <SettingRow
                title="Updates"
                helper={
                  updateState.error ??
                  (updateState.status === 'not-available'
                    ? 'Ferry is up to date.'
                    : updateState.status === 'available'
                      ? `Version ${updateState.version ?? 'new'} is downloading.`
                      : updateState.status === 'downloaded'
                        ? `Version ${updateState.version ?? 'new'} is ready to install.`
                        : 'Check the public Ferry Releases page for the latest beta.')
                }
              >
                <div className="button-row">
                  <UiV2.Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCheckingUpdates(true);
                      void window.ferryHost
                        ?.checkForUpdates()
                        .then(setUpdateState)
                        .finally(() => {
                          setCheckingUpdates(false);
                        });
                    }}
                  >
                    {checkingUpdates ? 'Checking…' : 'Check for updates'}
                  </UiV2.Button>
                  {updateState.status === 'available' && !updateState.autoDownload && (
                    <UiV2.Button
                      size="sm"
                      variant="default"
                      onClick={() => {
                        void window.ferryHost?.downloadUpdate().then(setUpdateState);
                      }}
                    >
                      Download update
                    </UiV2.Button>
                  )}
                </div>
              </SettingRow>
              {updateState.status === 'downloaded' && (
                <UiV2.Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    void window.ferryHost?.installUpdate();
                  }}
                >
                  Restart to update
                </UiV2.Button>
              )}
            </>
          )}
          <h3>Notices</h3>
          <div className="notice-list">
            <span>React Bits · MIT + Commons Clause</span>
            <span>lucide · ISC</span>
            <span>simple-icons · CC0</span>
            <span>Inter · OFL</span>
          </div>
        </Group>
      </>
    );
  };
  const pageCopy = settingsPageCopy[section] ?? {
    title: section,
    description: 'Adjust how Ferry works across your workspaces.',
  };
  return (
    <section className="canvas v2-settings-page">
      <nav className="v2-settings-nav" aria-label="Settings sections">
        {settingsSections.map((name) => (
          <button
            aria-current={section === name ? 'page' : undefined}
            className={section === name ? 'active' : ''}
            key={name}
            onClick={() => {
              useUI.getState().setSettingsSection(name);
            }}
            type="button"
          >
            {name}
          </button>
        ))}
      </nav>
      <main className="v2-settings-content">
        <h1 className="sr-only">Settings</h1>
        <PageHeader
          className="v2-settings-header"
          level={2}
          title={pageCopy.title}
          subtitle={pageCopy.description}
          primaryAction={
            pendingSettings || section === 'General' ? (
              <div className="v2-settings-actions">
                {section === 'General' && (
                  <UiV2.Button
                    variant="ghost"
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
                  >
                    Reset layout
                  </UiV2.Button>
                )}
                {pendingSettings && (
                  <UiV2.Button variant="default" onClick={() => void saveSettings()}>
                    Save changes
                  </UiV2.Button>
                )}
              </div>
            ) : undefined
          }
        />
        {body()}
      </main>
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
          <UiV2.Button
            onClick={() => {
              setConfirm('');
              setConfirmAction(null);
            }}
          >
            Cancel
          </UiV2.Button>
          <UiV2.Button
            variant="default"
            onClick={() => {
              setConfirm('');
              const action = confirmAction;
              setConfirmAction(null);
              if (action) void action();
              else
                toast({
                  kind: 'success',
                  title: 'Local data cleared',
                  body: 'Changes remain available after refresh.',
                });
            }}
          >
            Confirm
          </UiV2.Button>
        </div>
      </Dialog>
      <Dialog
        open={addMcp}
        onOpenChange={setAddMcp}
        title="Add MCP server"
        description="Add a local command or remote server URL. This demo records the setup request only."
      >
        <div className="dialog-form">
          <SettingsInput
            label="Name"
            value={mcpName}
            onChange={setMcpName}
            placeholder="Local tools"
          />
          <SettingsInput
            label="Command or URL"
            value={mcpAddress}
            onChange={setMcpAddress}
            placeholder="npx server or https://…"
          />
          <div className="button-row dialog-actions">
            <UiV2.Button
              onClick={() => {
                setAddMcp(false);
              }}
            >
              Cancel
            </UiV2.Button>
            <UiV2.Button
              variant="default"
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
            </UiV2.Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(gatewaySecret)}
        onOpenChange={(open) => {
          if (!open) setGatewaySecret('');
        }}
        title="Copy your Ferry key"
        description="This key is shown once. Copy it into your coding tool now. Ferry stores only its hash."
      >
        <div className="dialog-form">
          <pre>{gatewaySecret}</pre>
          <div className="button-row dialog-actions">
            <UiV2.Button onClick={() => void navigator.clipboard.writeText(gatewaySecret)}>
              Copy key
            </UiV2.Button>
            <UiV2.Button
              variant="default"
              onClick={() => {
                setGatewaySecret('');
              }}
            >
              Done
            </UiV2.Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  const section = useUI((state) => state.settingsSection);
  const sectionTitle = settingsPageCopy[section]?.title;
  const visibleTitle = title === sectionTitle ? undefined : title;
  return (
    <Section {...(visibleTitle ? { title: visibleTitle } : {})} className="settings-group-card">
      {children}
    </Section>
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
          '[{"effect":"ask","pattern":"npm test*","tool":"run_command"}]',
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
      <p className="permission-rules-help">
        Choose when Ferry may use a tool. Patterns match command text, for example{' '}
        <code>npm test*</code>.
      </p>
      <div aria-hidden="true" className="rule-columns text-meta text-text-3">
        <span>Decision</span>
        <span>Tool</span>
        <span>Pattern</span>
        <span />
      </div>
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
          <input
            aria-label="Rule pattern"
            placeholder="npm test*"
            value={rule.pattern}
            onChange={(event) => {
              persist(
                rules.map((item, i) =>
                  i === index ? { ...item, pattern: event.target.value } : item,
                ),
              );
            }}
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
      <UiV2.Button
        size="sm"
        onClick={() => {
          persist([...rules, { effect: 'ask', pattern: 'npm test*', tool: 'run_command' }]);
        }}
      >
        Add rule
      </UiV2.Button>
    </Group>
  );
}

function DeveloperSettings({
  providerHealth,
  mockLatency,
  injectErrors,
  realDomains,
  availableDomains,
  update,
}: {
  providerHealth: Provider[];
  mockLatency: boolean;
  injectErrors: boolean;
  realDomains: string[];
  availableDomains: string[];
  update: (patch: {
    mockLatency?: boolean;
    injectErrors?: boolean;
    realDomains?: string[];
  }) => void;
}) {
  const [simulateOffline, setSimulateOffline] = useState(
    () => localStorage.getItem('ferry.simulateOffline') === 'true',
  );
  const [engine, setEngine] = useState<{ status: string; pid?: number | null } | null>(null);
  const [nativeModules, setNativeModules] = useState<
    { name: string; ok: boolean; version: string | null; error: string | null }[]
  >([]);
  useEffect(() => {
    localStorage.setItem('ferry.simulateOffline', String(simulateOffline));
    window.dispatchEvent(new Event('ferry:offline-change'));
  }, [simulateOffline]);
  useEffect(() => {
    let active = true;
    if (!window.ferryHost) return;
    void window.ferryHost.getEngineStatus().then((status) => {
      if (active) setEngine(status);
    });
    const selfTest = window.ferryRpcClient?.system as
      { selfTest?: () => Promise<{ modules: typeof nativeModules }> } | undefined;
    if (selfTest?.selfTest)
      void selfTest.selfTest().then((result) => {
        if (active) setNativeModules(result.modules);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <Group title="Developer">
      <Section title="Routing health">
        {providerHealth.length ? (
          providerHealth.map((provider) => (
            <SettingRow
              key={provider.id}
              title={provider.name}
              helper={
                provider.health +
                (provider.cooldownUntil
                  ? ` · ${provider.cooldownProvenance ?? 'unknown reason'} · reset ${new Date(provider.cooldownUntil).toLocaleString()}`
                  : '')
              }
            />
          ))
        ) : (
          <p className="muted">No provider health data is available.</p>
        )}
      </Section>
      <SettingRow
        title="Core engine"
        helper={
          engine
            ? `${engine.status} · PID ${String(engine.pid ?? 'unavailable')} · ${window.ferryEngineHello?.protocol ?? 'ferry/1'}`
            : 'Connecting to the local core process…'
        }
      >
        <span className={`status-pill ${engine?.status === 'connected' ? 'ok' : 'pending'}`}>
          {engine?.status ?? 'connecting'}
        </span>
      </SettingRow>
      <SettingRow
        title="Domain routing"
        helper="Domains stay on mock until the core reports an implementation."
      >
        <div className="setting-inline-stack domain-routing-grid">
          {FERRY_DOMAINS.map((domain) => {
            const selectable = availableDomains.includes(domain);
            const route = realDomains.includes(domain) && selectable ? 'real' : 'mock';
            return (
              <label className="domain-route-control" key={domain}>
                <span>{domain}</span>
                <select
                  aria-label={`${domain} route`}
                  disabled={!selectable}
                  value={route}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    const next =
                      value === 'real'
                        ? [...new Set([...realDomains, domain])]
                        : realDomains.filter((name) => name !== domain);
                    window.ferryHybrid?.setRealDomains(
                      next.filter((name) => availableDomains.includes(name)),
                    );
                    update({ realDomains: next });
                  }}
                >
                  <option value="mock">Mock</option>
                  <option value="real">Real</option>
                </select>
              </label>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow
        title="Native module self-test"
        helper="Loaded inside the Electron utility process."
      >
        <div className="native-test-results">
          {nativeModules.length === 0 ? (
            <span className="muted">Not run</span>
          ) : (
            nativeModules.map((module) => (
              <span key={module.name} title={module.error ?? undefined}>
                {module.name}: {module.ok ? module.version : `failed: ${String(module.error)}`}
              </span>
            ))
          )}
        </div>
      </SettingRow>
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
