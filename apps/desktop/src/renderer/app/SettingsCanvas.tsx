import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useFerryClient } from '../data/client';
import { keys, useSettings } from '../data/queries';
import { useToasts } from '../state/toasts';
import { settingsSections, useUI } from '../state/ui';
import {
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
import {
  ProviderRequestOverridesSchema,
  type LogicalModelMapping,
  type Provider,
} from '@ferry/shared';
import type { RoutingSettings } from '@ferry/shared';
import type { UpdateSnapshot } from '../../main/update-state.js';
import {
  Eye,
  EyeOff,
  Gauge,
  Info,
  Keyboard,
  KeyRound,
  Layers,
  LockKeyhole,
  Network,
  Plus,
  Route,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ProviderKeyDialog } from './ProviderKeyDialog';
import { ProfilesSettings } from './ProfilesSettings';
import { ProvidersTable } from './ProvidersTable';
import { OAuthProviderRows } from './OAuthProviderRows';
import { ConfirmDialog } from './ConfirmDialog';
import { saveKeybindings, useKeybindings } from '../state/keybindings';
import type { SettingsSection } from '../state/ui.types';
const settingsSectionIcons: Record<SettingsSection, LucideIcon> = {
  General: SlidersHorizontal,
  Profiles: Layers,
  'Providers & keys': KeyRound,
  Routing: Route,
  Optimizers: Gauge,
  Delegation: Workflow,
  Permissions: ShieldCheck,
  Gateway: Network,
  'Data & privacy': LockKeyhole,
  Shortcuts: Keyboard,
  About: Info,
};
const settingsSectionKeywords: Record<SettingsSection, string[]> = {
  General: ['theme', 'dark', 'light', 'font', 'appearance', 'home', 'onboarding', 'layout'],
  Profiles: ['profile', 'auto-free', 'fallback', 'caps', 'planner', 'editor', 'tier'],
  'Providers & keys': ['provider', 'key', 'api key', 'oauth', 'subscription', 'trial', 'login'],
  Routing: ['routing', 'spending', 'caps', 'sticky', 'quota', 'mapping', 'override'],
  Optimizers: ['optimizer', 'terse', 'tokens', 'context', 'compression', 'rtk'],
  Delegation: ['delegation', 'codex', 'opencode', 'claude', 'agent', 'lane'],
  Permissions: ['permission', 'approval', 'rules', 'auto-edit'],
  Gateway: ['gateway', 'api', 'port', 'lan', 'openai', 'anthropic'],
  'Data & privacy': ['data', 'privacy', 'logs', 'retention', 'mcp', 'skills', 'integrations'],
  Shortcuts: ['shortcut', 'keybinding', 'keyboard'],
  About: ['about', 'version', 'update', 'license', 'notices'],
};
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
  const [keybindingsSaved, setKeybindingsSaved] = useState(false);
  const [keybindingsSaveError, setKeybindingsSaveError] = useState<string | null>(null);
  useEffect(() => {
    setKeybindingsDraft(keybindings.content);
  }, [keybindings.content]);
  const section = useUI((state) => state.settingsSection);
  const [sectionQuery, setSectionQuery] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmAction, setConfirmAction] = useState<(() => void | Promise<void>) | null>(null);
  const [confirmDescription, setConfirmDescription] = useState(
    'Review this change before confirming.',
  );
  const [confirmDestructive, setConfirmDestructive] = useState(false);
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
  const [saveFeedback, setSaveFeedback] = useState<
    Partial<Record<SettingsSection, { kind: 'saved' } | { kind: 'error'; message: string }>>
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
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: oauthProviders = [] } = useQuery({
    queryKey: ['oauth-providers'],
    queryFn: () => client.oauth.list(),
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
  const gateway = gatewayQuery.data;
  const gatewayStatus = gateway?.status;
  const gatewayPort = gateway?.port ?? 11435;
  const updateGateway = async (
    patch: Partial<{ enabled: boolean; port: number; allowLan: boolean }>,
  ) => {
    if (!gateway) return;
    const enablingLan = patch.allowLan === true && !gateway.allowLan;
    if (enablingLan) {
      setConfirm('Allow local network access?');
      setConfirmDescription('Other devices on this network will be able to connect to Ferry.');
      setConfirmDestructive(false);
      setConfirmAction(() => async () => {
        await client.gateway.setSettings({
          enabled: gateway.enabled,
          port: gateway.port,
          allowLan: gateway.allowLan,
          ...patch,
          confirmLan: true,
        });
        await cache.invalidateQueries({ queryKey: ['gateway-settings'] });
      });
      return;
    }
    await client.gateway.setSettings({
      enabled: gateway.enabled,
      port: gateway.port,
      allowLan: gateway.allowLan,
      ...patch,
    });
    await cache.invalidateQueries({ queryKey: ['gateway-settings'] });
  };
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
    setSaveFeedback((current) => {
      const next = { ...current };
      Reflect.deleteProperty(next, section);
      return next;
    });
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
      setSaveFeedback((current) => ({ ...current, [section]: { kind: 'saved' } }));
    } catch (error) {
      setSaveFeedback((current) => ({
        ...current,
        [section]: {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
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
                    { value: 'hero', label: 'Hero' },
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
                  variant="outline"
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
                setKeybindingsSaved(false);
                setKeybindingsSaveError(null);
              }}
            />
            {keybindingsDraft !== keybindings.content && (
              <UiV2.Button
                size="sm"
                onClick={() => {
                  saveKeybindings(keybindingsDraft)
                    .then((errors) => {
                      if (errors.length) setKeybindingsSaveError(errors.join('; '));
                      else setKeybindingsSaved(true);
                    })
                    .catch((error: unknown) => {
                      setKeybindingsSaveError(
                        error instanceof Error ? error.message : String(error),
                      );
                    });
                }}
              >
                Save changes
              </UiV2.Button>
            )}
            {keybindingsSaved && (
              <span aria-label="Saved" className="v2-settings-save-success" role="status">
                Saved
              </span>
            )}
            {keybindingsSaveError && (
              <span className="v2-settings-save-error" role="alert">
                Could not save: {keybindingsSaveError}
              </span>
            )}
          </Group>
        </>
      );
    if (section === 'Profiles') return <ProfilesSettings />;
    if (section === 'Providers & keys')
      return (
        <Group>
          <p className="muted">
            Keys are stored locally. Use keys you own under one account; pooling accounts to
            multiply free tiers may violate provider terms.
          </p>
          <ProvidersTable
            onManage={setKeyProvider}
            onTest={(provider) => void testProvider(provider)}
            onToggle={(provider, enabled) =>
              void client.providers
                .setEnabled(provider.id, enabled)
                .then(() => cache.invalidateQueries({ queryKey: ['providers'] }))
            }
            providers={providers.filter((provider) => provider.tag !== 'subscription_oauth')}
            testing={testingProvider}
          />
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
          <Group title="Keys and connected tools">
            <SettingRow
              title="Gateway dashboard"
              helper="Create keys, copy setup for OpenCode, Claude Code or Codex, and watch requests live."
            >
              <UiV2.Button
                size="sm"
                variant="outline"
                onClick={() => void navigate({ to: '/gateway' })}
              >
                Open Gateway
              </UiV2.Button>
            </SettingRow>
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
          {settings && (
            <RoutingMappingsEditor
              routing={settings.routing}
              providers={providers}
              update={(routing) => void update({ routing })}
            />
          )}
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
        <>
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
          </Group>
          <Group title="Merged lanes">
            <p className="muted">
              Agents Ferry can hand work to, merged from your user and project configuration.
            </p>
            <ul className="v2-list" aria-label="Merged lanes">
              {lanes.map((lane) => (
                <li className="v2-list-row" key={lane.name}>
                  <span className="v2-list-main">
                    <strong>{lane.name}</strong>
                    <small>
                      {lane.implementer} · {lane.model ?? lane.effort ?? lane.variant ?? 'Default'}
                    </small>
                  </span>
                  <span className="v2-list-meta">{lane.source}</span>
                  <span className="v2-status-pill" data-tone={lane.trusted ? 'success' : 'warning'}>
                    {lane.trusted ? 'Trusted' : 'Untrusted'}
                  </span>
                </li>
              ))}
            </ul>
            {lanes.some((lane) => lane.implementer === 'opencode' && !lane.model?.trim()) && (
              <p className="muted" role="status">
                Choose a model for the OpenCode lane in its lane configuration, or set a default
                model in your OpenCode config. Delegation cannot start without one.
              </p>
            )}
          </Group>
          <Group title="Coding CLIs">
            <p className="muted">Command-line agents Ferry found on this computer.</p>
            <ul className="v2-list" aria-label="Coding CLIs">
              {providers
                .filter((provider) => provider.kind === 'cli')
                .map((provider) => (
                  <li className="v2-list-row" key={provider.id}>
                    <span className="v2-list-main">
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.keyStatus === 'not_applicable'
                          ? 'Detected and ready'
                          : 'Installed; sign-in not verified'}
                      </small>
                    </span>
                    <span
                      className="v2-status-pill"
                      data-tone={provider.keyStatus === 'not_applicable' ? 'success' : 'muted'}
                    >
                      {provider.keyStatus === 'not_applicable' ? 'Available' : 'Installed'}
                    </span>
                  </li>
                ))}
            </ul>
          </Group>
          <Group title="ACP agent detection">
            <p className="muted">
              Agents that speak the Agent Client Protocol. Ferry checks PATH and the version
              command; Pi credentials remain managed by Pi.
            </p>
            <ul className="v2-list" aria-label="ACP agents">
              {acpAgents.map((agent) => {
                const configured = lanes.some(
                  (lane) => lane.implementer === 'acp' && lane.agent === agent.id,
                );
                return (
                  <li className="v2-list-row" key={agent.id}>
                    <span className="v2-list-main">
                      <strong>{agent.name}</strong>
                      <small>
                        {agent.available
                          ? `${agent.version ?? agent.executable ?? agent.command}${configured ? ' · Configured in a lane' : ''}`
                          : agent.installHint}
                      </small>
                    </span>
                    {agent.verified && (
                      <span className="v2-list-meta">Verified {agent.verifiedAt}</span>
                    )}
                    {agent.caution && (
                      <span className="v2-status-pill" data-tone="warning">
                        {agent.cautionNote ?? 'Use caution'}
                      </span>
                    )}
                    <span
                      className="v2-status-pill"
                      data-tone={agent.available ? 'success' : 'muted'}
                    >
                      {agent.available ? 'Installed' : 'Not installed'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Group>
        </>
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
              <UiV2.Button size="sm" disabled>
                Export data
              </UiV2.Button>
              <UiV2.Button size="sm" disabled>
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
            <span>LobeHub icons · MIT</span>
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
  const needle = sectionQuery.trim().toLocaleLowerCase();
  const visibleSections = settingsSections.filter(
    (name) =>
      !needle ||
      name.toLocaleLowerCase().includes(needle) ||
      settingsSectionKeywords[name].some((keyword) => keyword.includes(needle)),
  );
  return (
    <section className="canvas v2-settings-page">
      <aside className="v2-settings-sidebar">
        <label className="v2-settings-search">
          <Search aria-hidden="true" />
          <input
            aria-label="Search settings"
            onChange={(event) => {
              setSectionQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              const first = visibleSections[0];
              if (event.key === 'Enter' && first) useUI.getState().setSettingsSection(first);
            }}
            placeholder="Search"
            value={sectionQuery}
          />
        </label>
        <span className="v2-settings-sidebar-label">Settings</span>
        <nav className="v2-settings-nav" aria-label="Settings sections">
          {visibleSections.map((name) => {
            const Icon = settingsSectionIcons[name];
            return (
              <button
                aria-current={section === name ? 'page' : undefined}
                className={section === name ? 'active' : ''}
                key={name}
                onClick={() => {
                  useUI.getState().setSettingsSection(name);
                }}
                type="button"
              >
                <Icon aria-hidden="true" />
                {name}
              </button>
            );
          })}
          {visibleSections.length === 0 && (
            <p className="v2-settings-no-results">No matching settings</p>
          )}
        </nav>
      </aside>
      <div className="v2-settings-content">
        <UiV2.Button
          aria-label="Close settings"
          className="v2-settings-close"
          onClick={() => {
            useUI.getState().closeSettings();
          }}
          size="icon"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </UiV2.Button>
        <PageHeader
          className="v2-settings-header"
          level={2}
          title={pageCopy.title}
          subtitle={pageCopy.description}
          primaryAction={
            pendingSettings ||
            section === 'General' ||
            (section !== 'Profiles' && saveFeedback[section]) ? (
              <div className="v2-settings-actions">
                {section === 'General' && (
                  <UiV2.Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setConfirm('Reset layout?');
                      setConfirmDescription(
                        'This restores the sidebar and panel sizes to their defaults.',
                      );
                      setConfirmDestructive(false);
                      setConfirmAction(() => () => {
                        useUI.getState().resetLayout();
                      });
                    }}
                  >
                    Reset layout
                  </UiV2.Button>
                )}
                {pendingSettings && (
                  <UiV2.Button size="sm" variant="default" onClick={() => void saveSettings()}>
                    Save changes
                  </UiV2.Button>
                )}
                {saveFeedback[section]?.kind === 'saved' && (
                  <span aria-label="Saved" className="v2-settings-save-success" role="status">
                    Saved
                  </span>
                )}
                {saveFeedback[section]?.kind === 'error' && (
                  <span className="v2-settings-save-error" role="alert">
                    Could not save: {saveFeedback[section].message}
                  </span>
                )}
              </div>
            ) : undefined
          }
        />
        {body()}
      </div>
      <ProviderKeyDialog
        showRoutingControls
        provider={keyProvider}
        open={Boolean(keyProvider)}
        onOpenChange={(open) => {
          if (!open) setKeyProvider(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm('');
            setConfirmAction(null);
          }
        }}
        title={confirm}
        description={confirmDescription}
        confirmLabel="Confirm"
        destructive={confirmDestructive}
        onConfirm={() => {
          setConfirm('');
          const action = confirmAction;
          setConfirmAction(null);
          if (action) void action();
        }}
      />
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
                setMcpName('');
                setMcpAddress('');
              }}
            >
              Add server
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

function RoutingMappingsEditor({
  routing,
  providers,
  update,
}: {
  routing: RoutingSettings;
  providers: Provider[];
  update: (routing: RoutingSettings) => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 'groq');
  const [overrideDraft, setOverrideDraft] = useState('');
  const [overrideError, setOverrideError] = useState('');
  const selectedOverrides = routing.providerOverrides[providerId as Provider['id']] ?? {
    stripParams: [],
    forceParams: {},
    headers: {},
    statusRemaps: [],
  };
  useEffect(() => {
    setOverrideDraft(JSON.stringify(selectedOverrides, null, 2));
    setOverrideError('');
  }, [providerId, routing.providerOverrides]);

  const changeMapping = (index: number, mapping: LogicalModelMapping) => {
    const logicalModelMappings = routing.logicalModelMappings.map((item, itemIndex) =>
      itemIndex === index ? mapping : item,
    );
    update({ ...routing, logicalModelMappings });
  };

  return (
    <>
      <Group title="Logical model mappings">
        <p className="muted">
          Give one model name to multiple upstream models. Gateway requests still use normal routing
          eligibility and free-first scoring.
        </p>
        <div className="routing-mapping-table" role="table" aria-label="Logical model mappings">
          <div className="routing-mapping-row routing-mapping-header" role="row">
            <span role="columnheader">Logical name</span>
            <span role="columnheader">Provider</span>
            <span role="columnheader">Upstream ID</span>
            <span />
          </div>
          {routing.logicalModelMappings.map((mapping, index) => (
            <div
              className="routing-mapping-row"
              key={`${mapping.logicalName}-${String(index)}`}
              role="row"
            >
              <input
                aria-label={`Logical name ${String(index + 1)}`}
                value={mapping.logicalName}
                onChange={(event) => {
                  changeMapping(index, { ...mapping, logicalName: event.target.value });
                }}
              />
              <Select
                label={`Provider ${String(index + 1)}`}
                value={mapping.providerId}
                onValueChange={(value) => {
                  changeMapping(index, { ...mapping, providerId: value as Provider['id'] });
                }}
                options={providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                }))}
              />
              <input
                aria-label={`Upstream ID ${String(index + 1)}`}
                value={mapping.upstreamId}
                onChange={(event) => {
                  changeMapping(index, { ...mapping, upstreamId: event.target.value });
                }}
              />
              <UiV2.Button
                size="icon"
                variant="ghost"
                aria-label={`Remove mapping ${mapping.logicalName}`}
                onClick={() => {
                  update({
                    ...routing,
                    logicalModelMappings: routing.logicalModelMappings.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  });
                }}
              >
                {'\u00d7'}
              </UiV2.Button>
            </div>
          ))}
        </div>
        <UiV2.Button
          size="sm"
          variant="outline"
          onClick={() => {
            update({
              ...routing,
              logicalModelMappings: [
                ...routing.logicalModelMappings,
                {
                  logicalName: 'my-model',
                  providerId: providers[0]?.id ?? ('groq' as Provider['id']),
                  upstreamId: '',
                },
              ],
            });
          }}
        >
          Add mapping
        </UiV2.Button>
      </Group>
      <Group title="Provider request overrides">
        <p className="muted">
          Strip or force request parameters, add headers, or map an upstream error status. Catalog
          defaults are included when no user value replaces them.
        </p>
        <div className="v2-settings-field">
          <span>Provider</span>
          <Select
            label="Provider"
            value={providerId}
            onValueChange={setProviderId}
            options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
          />
        </div>
        <label className="v2-settings-field">
          <span>Overrides (JSON)</span>
          <textarea
            aria-label="Provider request overrides JSON"
            className="routing-overrides-editor"
            spellCheck={false}
            value={overrideDraft}
            onChange={(event) => {
              setOverrideDraft(event.target.value);
            }}
          />
        </label>
        {overrideError && (
          <p className="text-destructive" role="alert">
            {overrideError}
          </p>
        )}
        <UiV2.Button
          size="sm"
          variant="outline"
          onClick={() => {
            try {
              const parsed: unknown = JSON.parse(overrideDraft);
              const validated = ProviderRequestOverridesSchema.parse(parsed);
              update({
                ...routing,
                providerOverrides: { ...routing.providerOverrides, [providerId]: validated },
              });
              setOverrideError('');
            } catch (error) {
              setOverrideError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Apply override
        </UiV2.Button>
      </Group>
    </>
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
        variant="outline"
        onClick={() => {
          persist([...rules, { effect: 'ask', pattern: 'npm test*', tool: 'run_command' }]);
        }}
      >
        <Plus aria-hidden="true" />
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
                <SegmentedControl
                  label={`${domain} route`}
                  value={route}
                  options={[
                    { value: 'mock', label: 'Mock' },
                    { value: 'real', label: 'Real', disabled: !selectable },
                  ]}
                  onValueChange={(value) => {
                    const next =
                      value === 'real'
                        ? [...new Set([...realDomains, domain])]
                        : realDomains.filter((name) => name !== domain);
                    window.ferryHybrid?.setRealDomains(
                      next.filter((name) => availableDomains.includes(name)),
                    );
                    update({ realDomains: next });
                  }}
                />
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
