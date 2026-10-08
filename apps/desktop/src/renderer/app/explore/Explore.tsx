import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, Plus, Search, X } from 'lucide-react';
import type { OAuthProvider, Provider } from '@ferry/shared';
import {
  EmptyState,
  ErrorState,
  ProviderLogo,
  DataUseBadge,
  dataUseStatus,
  TagBadge,
  Section,
  SegmentedControl,
  Skeleton,
  UiV2,
  PageHeader,
} from '@ferry/ui';
import { ProvidersTable } from '../ProvidersTable';
import { useFerryClient } from '../../data/client';
import { useToasts } from '../../state/toasts';
import { useUI } from '../../state/ui';
import { ProviderKeyDialog } from '../ProviderKeyDialog';
import { OAuthProviderRows } from '../OAuthProviderRows';
import { UsageTab } from './Usage';
import { HealthTab } from './Health';

type ModelSort =
  | 'name'
  | 'providerId'
  | 'tier'
  | 'contextWindow'
  | 'toolCalling'
  | 'free'
  | 'priceInPerM'
  | 'priceOutPerM';
const modelFilters = ['All tiers', 'T1', 'T2', 'T3'] as const;
const freeFilters = ['All', 'Free', 'Paid'] as const;
const compact = (value: number | null) =>
  value === null ? '—' : value === 0 ? 'Free' : `$${value.toFixed(2)}`;

export function ModelsCanvas() {
  const client = useFerryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const routeTab =
    pathname === '/models/usage'
      ? 'usage'
      : pathname === '/models/health'
        ? 'health'
        : pathname === '/models/catalog'
          ? 'models'
          : 'providers';
  const [selectedTab, setSelectedTab] = useState(routeTab);
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const providerFilter = useUI((state) => state.exploreFilter);
  const [search, setSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [modelOffset, setModelOffset] = useState(0);
  const [modelLimit, setModelLimit] = useState(50);
  const benchmarkFullList =
    import.meta.env.DEV &&
    new URLSearchParams(location.search).get('demo') === 'explore-perf' &&
    new URLSearchParams(location.search).get('perfList') === 'all';
  const effectiveModelLimit = benchmarkFullList ? 1_200 : modelLimit;
  const [modelTier, setModelTier] = useState<(typeof modelFilters)[number]>('All tiers');
  const [modelKind, setModelKind] = useState<(typeof freeFilters)[number]>('All');
  const [sort, setSort] = useState<{ key: ModelSort; ascending: boolean }>({
    key: 'name',
    ascending: true,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'add' | 'manage'>('add');
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [activeOAuthProvider, setActiveOAuthProvider] = useState<OAuthProvider | null>(null);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeFeedback, setProbeFeedback] = useState<Record<string, string>>({});
  const [recentlyUpdatedProviderIds, setRecentlyUpdatedProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const {
    data: providers = [],
    isLoading: providersLoading,
    isError: providersError,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: modelPage = { items: [], total: 0 } } = useQuery({
    queryKey: ['models', modelSearch, modelTier, modelKind, sort, modelOffset, effectiveModelLimit],
    queryFn: () =>
      client.models.page({
        offset: modelOffset,
        limit: effectiveModelLimit,
        query: modelSearch,
        filters: {
          ...(modelTier !== 'All tiers' ? { tier: modelTier } : {}),
          ...(modelKind !== 'All' ? { free: modelKind === 'Free' } : {}),
        },
        sort,
      }),
  });
  const { items: models, total: modelTotal } = modelPage;
  const {
    data: oauthProviders = [],
    error: oauthError,
    refetch: refetchOAuth,
  } = useQuery({
    queryKey: ['oauth-providers'],
    queryFn: () => client.oauth.list(),
  });
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => client.settings.get(),
  });

  useEffect(() => {
    setSelectedTab(routeTab);
  }, [routeTab]);

  useEffect(() => {
    const off = client.on('provider.updated', (provider) => {
      setRecentlyUpdatedProviderIds((current) => new Set(current).add(provider.id));
      cache.setQueryData<Provider[]>(['providers'], (current = []) =>
        current.map((item) => (item.id === provider.id ? provider : item)),
      );
    });
    return off;
  }, [cache, client]);

  useEffect(
    () =>
      client.on('oauth.progress', (event) => {
        if (event.type === 'device_code')
          pushToast({
            kind: 'warning',
            title: 'Complete sign-in in your browser',
            body: `Enter ${event.userCode} at ${event.verificationUri}`,
          });
        else if (event.type === 'open_url')
          pushToast({
            kind: 'info',
            title: 'Sign-in opened in your browser',
            body: event.instructions ?? null,
          });
      }),
    [client, pushToast],
  );

  const providerNames = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  );
  const isProviderPriority = (provider: Provider) =>
    provider.keyStatus === 'invalid' ||
    ['cooldown', 'down', 'auth_invalid', 'account_disabled'].includes(provider.health);
  const visibleProviders = providers.filter((provider) => {
    const query = search.trim().toLowerCase();
    const matchesFilter =
      providerFilter === 'All' ||
      (providerFilter === 'Free' &&
        provider.tag !== 'paid' &&
        provider.tag !== 'subscription_oauth' &&
        provider.kind !== 'cli' &&
        provider.tag !== 'subscription_cli') ||
      (providerFilter === 'Needs attention' && isProviderPriority(provider)) ||
      (providerFilter === 'Configured' &&
        (provider.keyStatus === 'valid' || provider.keyStatus === 'not_applicable'));
    return (
      provider.tag !== 'subscription_oauth' &&
      matchesFilter &&
      (!query || provider.name.toLowerCase().includes(query) || provider.id.includes(query))
    );
  });
  const isPriority = (provider: Provider) =>
    recentlyUpdatedProviderIds.has(provider.id) || isProviderPriority(provider);
  const pinnedProviders = visibleProviders.filter(isPriority);
  const providerListItems = [
    ...pinnedProviders,
    ...visibleProviders.filter((provider) => !isPriority(provider)),
  ];
  const visibleModels = models;

  const openAdd = () => {
    setDialogMode('add');
    setActiveProvider(null);
    setDialogOpen(true);
  };
  const openManage = (provider: Provider) => {
    setActiveProvider(provider);
    setDialogMode('manage');
    setDialogOpen(false);
  };
  const closeDialog = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setActiveProvider(null);
    }
  };
  const probe = async (provider: Provider) => {
    setProbeFeedback((current) => ({ ...current, [provider.id]: '' }));
    setProbing(provider.id);
    try {
      const result = await client.providers.probe(provider.id);
      setProbeFeedback((current) => ({
        ...current,
        [provider.id]: result.ok
          ? `Connected \u00B7 ${result.latencyMs === null ? 'CLI' : `${String(result.latencyMs)} ms`}`
          : result.keyValid
            ? result.message
            : `Key invalid \u00B7 ${result.message}`,
      }));
      if (!result.ok) pushToast({ kind: 'error', title: 'Key invalid', body: result.message });
      else
        pushToast({
          kind: 'success',
          title: `${provider.name} connected`,
          body: result.latencyMs === null ? 'CLI available' : `${String(result.latencyMs)} ms`,
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Try again.';
      setProbeFeedback((current) => ({ ...current, [provider.id]: message }));
      pushToast({
        kind: 'error',
        title: 'Provider test failed',
        body: message,
      });
    } finally {
      setProbing(null);
    }
  };
  const toggleProvider = async (provider: Provider, enabled: boolean) => {
    await client.providers.setEnabled(provider.id, enabled);
    await cache.invalidateQueries({ queryKey: ['providers'] });
  };
  const sortModels = (key: ModelSort) => {
    setSort((current) => ({ key, ascending: current.key === key ? !current.ascending : true }));
    setModelOffset(0);
  };
  const sortLabel = (key: ModelSort, label: string) => (
    <button
      aria-label={`Sort by ${label}`}
      className="inline-flex items-center gap-1 text-left text-muted-foreground hover:text-foreground"
      onClick={() => {
        sortModels(key);
      }}
      type="button"
    >
      {label}
      {sort.key === key ? sort.ascending ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}
    </button>
  );
  const loginOAuth = async (provider = activeOAuthProvider, gateway?: string) => {
    if (!provider || (provider.riskLevel === 'high' && !riskAcknowledged)) return;
    setOauthLoading(true);
    try {
      const acknowledged = settings?.subscriptionOAuthAcknowledged ?? [];
      if (provider.riskLevel === 'high' && !acknowledged.includes(provider.id))
        await client.settings.update({
          subscriptionOAuthAcknowledged: [...acknowledged, provider.id],
        });
      await client.oauth.login(provider.id, ...(gateway ? [{ gateway }] : []));
      await cache.invalidateQueries({ queryKey: ['oauth-providers'] });
      setActiveOAuthProvider(null);
      setRiskAcknowledged(false);
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Subscription login failed',
        body: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setOauthLoading(false);
    }
  };
  const requestOAuthAction = (provider: OAuthProvider, gateway?: string) => {
    if (provider.connected) {
      void client.oauth
        .logout(provider.id)
        .then(() => cache.invalidateQueries({ queryKey: ['oauth-providers'] }));
    } else if (provider.riskLevel === 'high') {
      setActiveOAuthProvider(provider);
      setRiskAcknowledged(settings?.subscriptionOAuthAcknowledged.includes(provider.id) ?? false);
    } else void loginOAuth(provider, gateway);
  };

  return (
    <section
      aria-label="Models"
      className="v2-models-page min-h-0 w-full flex-1 overflow-y-auto px-8 py-8"
    >
      <div className="mx-auto grid w-full max-w-[1040px] gap-6">
        <PageHeader title="Models" subtitle="Providers, model capabilities and usage" />
        <UiV2.Tabs
          onValueChange={(value) => {
            setSelectedTab(value);
            const path =
              value === 'usage'
                ? '/models/usage'
                : value === 'health'
                  ? '/models/health'
                  : value === 'models'
                    ? '/models/catalog'
                    : '/models';
            void navigate({ to: path });
          }}
          value={selectedTab}
        >
          <UiV2.TabsList aria-label="Models sections">
            <UiV2.TabsTrigger value="providers">Providers</UiV2.TabsTrigger>
            <UiV2.TabsTrigger value="models">Models</UiV2.TabsTrigger>
            <UiV2.TabsTrigger value="usage">Usage</UiV2.TabsTrigger>
            <UiV2.TabsTrigger value="health">Health</UiV2.TabsTrigger>
          </UiV2.TabsList>
          <UiV2.TabsContent className="grid gap-6" value="providers">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex h-9 w-full max-w-xs items-center gap-2 rounded-control border border-input bg-background px-3 text-muted-foreground">
                <Search aria-hidden="true" size={16} />
                <input
                  aria-label="Search providers"
                  className="min-w-0 flex-1 bg-transparent text-ui-body text-foreground outline-none placeholder:text-muted-foreground"
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                  placeholder="Search providers"
                  value={search}
                />
                {search && (
                  <button
                    aria-label="Clear provider search"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setSearch('');
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                )}
              </label>
              <nav
                aria-label="Provider filters"
                className="flex flex-wrap gap-1 rounded-button bg-muted p-1"
              >
                {(['All', 'Free', 'Needs attention', 'Configured'] as const).map((item) => (
                  <button
                    aria-pressed={providerFilter === item}
                    className={`rounded-control px-3 py-1.5 text-ui-label transition-colors ${providerFilter === item ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    key={item}
                    onClick={() => {
                      useUI.getState().setExploreFilter(item);
                    }}
                    type="button"
                  >
                    {item}
                  </button>
                ))}
              </nav>
              <span className="ml-auto flex items-center gap-3">
                <span className="text-ui-meta tabular-nums text-muted-foreground">
                  {visibleProviders.length} providers
                </span>
                <UiV2.Button onClick={openAdd} size="sm">
                  <Plus aria-hidden="true" />
                  Add provider
                </UiV2.Button>
              </span>
            </div>
            {providersLoading ? (
              <Skeleton rows={4} />
            ) : providersError ? (
              <ErrorState
                title="Provider list could not load"
                action="Retry"
                onAction={() => void refetchProviders()}
              />
            ) : visibleProviders.length > 0 ? (
              <ProvidersTable
                feedback={probeFeedback}
                onManage={openManage}
                onTest={(provider) => void probe(provider)}
                onToggle={(provider, enabled) => void toggleProvider(provider, enabled)}
                providers={providerListItems}
                testing={probing}
              />
            ) : providers.length === 0 ? (
              <div className="grid gap-2 py-10 text-center">
                <h2 className="text-ui-section font-semibold">No providers connected</h2>
                <p className="text-ui-secondary text-muted-foreground">
                  Use Add provider above to connect a provider.
                </p>
              </div>
            ) : (
              <EmptyState
                title="No providers match this search"
                action="Clear filters"
                onAction={() => {
                  setSearch('');
                  useUI.getState().setExploreFilter('All');
                }}
              />
            )}
            <Section title="Subscription sign-ins">
              <OAuthProviderRows
                onLogin={requestOAuthAction}
                onLogout={requestOAuthAction}
                providers={oauthProviders}
                loadError={oauthError ? oauthError.message : null}
                onRetry={() => void refetchOAuth()}
              />
            </Section>
          </UiV2.TabsContent>
          <UiV2.TabsContent className="min-w-0" value="models">
            <Section ariaLabel="Model comparison" className="grid gap-3">
              <header className="flex flex-wrap items-end gap-3">
                <div className="mr-auto">
                  <p className="text-meta text-text-3">
                    Compare capabilities and published pricing
                  </p>
                </div>
                <div aria-label="Filter by tier" className="flex gap-1">
                  {modelFilters.map((item) => (
                    <button
                      aria-pressed={modelTier === item}
                      className={`rounded-control px-2.5 py-1.5 text-ui-meta ${modelTier === item ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                      key={item}
                      onClick={() => {
                        setModelTier(item);
                        setModelOffset(0);
                      }}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <div aria-label="Filter by model cost" className="flex gap-1">
                  {freeFilters.map((item) => (
                    <button
                      aria-pressed={modelKind === item}
                      className={`rounded-control px-2.5 py-1.5 text-ui-meta ${modelKind === item ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                      key={item}
                      onClick={() => {
                        setModelKind(item);
                        setModelOffset(0);
                      }}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </header>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-w-56 flex-1 items-center gap-2 rounded-control border border-input bg-background px-3 py-2 text-ui-meta text-muted-foreground">
                  <Search aria-hidden="true" size={14} />
                  <span className="sr-only">Search models</span>
                  <input
                    aria-label="Search models"
                    className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
                    onChange={(event) => {
                      setModelSearch(event.target.value);
                      setModelOffset(0);
                    }}
                    placeholder="Search models"
                    type="search"
                    value={modelSearch}
                  />
                </label>
                <span
                  aria-live="polite"
                  className="text-ui-meta tabular-nums text-muted-foreground"
                >
                  {modelTotal === 0
                    ? '0 models'
                    : `${String(modelOffset + 1)}–${String(Math.min(modelOffset + effectiveModelLimit, modelTotal))} of ${new Intl.NumberFormat().format(modelTotal)}`}
                </span>
                <span className="flex items-center gap-2 text-ui-meta text-muted-foreground">
                  Rows
                  <SegmentedControl
                    label="Models per page"
                    onValueChange={(value) => {
                      setModelLimit(Number(value));
                      setModelOffset(0);
                    }}
                    options={[25, 50, 100].map((size) => ({
                      value: String(size),
                      label: String(size),
                    }))}
                    value={String(modelLimit)}
                  />
                </span>
              </div>
              <div
                className="model-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Model comparison table, scroll horizontally for more columns"
              >
                <table className="w-full min-w-[760px] border-collapse text-left text-meta">
                  <thead className="bg-muted text-muted-foreground">
                    <tr className="h-9 border-b border-border">
                      <th className="px-3 font-medium">{sortLabel('name', 'Model')}</th>
                      <th className="px-3 font-medium">{sortLabel('providerId', 'Provider')}</th>
                      <th className="px-3 font-medium">{sortLabel('tier', 'Tier')}</th>
                      <th className="px-3 font-medium">{sortLabel('contextWindow', 'Context')}</th>
                      <th className="px-3 font-medium">{sortLabel('toolCalling', 'Tools')}</th>
                      <th className="px-3 font-medium">{sortLabel('free', 'Price')}</th>
                      <th className="px-3 font-medium">{sortLabel('priceInPerM', '$/M in')}</th>
                      <th className="px-3 font-medium">{sortLabel('priceOutPerM', '$/M out')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleModels.map((model) => (
                      <tr
                        className="h-10 border-b border-border last:border-0 hover:bg-muted/50"
                        key={model.ref}
                      >
                        <td
                          className="max-w-56 truncate px-3 font-medium text-foreground"
                          title={model.name}
                        >
                          <ProviderLogo
                            className="mr-2 align-[-3px]"
                            model={`${model.ref} ${model.name}`}
                            name={model.name}
                            providerId={model.providerId}
                            size={16}
                          />
                          <span>{model.name}</span>
                          {providers.find((provider) => provider.id === model.providerId)?.tag ===
                            'promo' && (
                            <span
                              className="ml-2 rounded-full bg-warning/10 px-2 py-0.5 text-ui-meta text-warning"
                              title="Promotional — may end without notice"
                            >
                              Promo
                            </span>
                          )}
                          {providers.find((provider) => provider.id === model.providerId)?.tag ===
                            'trial' && <TagBadge className="ml-2" kind="trial" />}
                          {model.quality !== null && model.quality !== undefined && (
                            <span className="ml-2 text-ui-meta text-muted-foreground">
                              Quality {Math.round(model.quality * 100)}%
                            </span>
                          )}
                          {dataUseStatus(
                            providers.find((provider) => provider.id === model.providerId)?.dataUse,
                          ) === 'training' && (
                            <span className="ml-2 inline-block align-middle">
                              <DataUseBadge
                                dataUse={
                                  providers.find((provider) => provider.id === model.providerId)
                                    ?.dataUse
                                }
                              />
                            </span>
                          )}
                          {oauthProviders.some(
                            (provider) =>
                              model.providerId === provider.id && provider.riskLevel === 'high',
                          ) && (
                            <span
                              className="ml-2 rounded-full bg-warning/10 px-2 py-0.5 text-ui-meta text-warning"
                              title="Unofficial subscription access may lead to account suspension"
                            >
                              Subscription OAuth · risk
                            </span>
                          )}
                        </td>
                        <td className="px-3 text-muted-foreground">
                          <span className="inline-flex items-center gap-2">
                            <ProviderLogo
                              name={providerNames[model.providerId] ?? model.providerId}
                              providerId={model.providerId}
                              size={14}
                            />
                            {providerNames[model.providerId] ?? model.providerId}
                          </span>
                        </td>
                        <td className="px-3">
                          <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">
                            {model.tier}
                          </span>
                        </td>
                        <td className="px-3 tabular-nums text-muted-foreground">
                          {new Intl.NumberFormat().format(model.contextWindow)}
                        </td>
                        <td className="px-3">
                          {model.toolCalling ? (
                            <Check
                              aria-label="Tools supported"
                              className="text-success"
                              size={14}
                            />
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 text-muted-foreground">
                          {model.free ? 'Free' : 'Paid'}
                        </td>
                        <td className="px-3 tabular-nums text-muted-foreground">
                          {compact(model.priceInPerM)}
                        </td>
                        <td className="px-3 tabular-nums text-muted-foreground">
                          {compact(model.priceOutPerM)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visibleModels.length === 0 && (
                  <p className="p-5 text-center text-ui-body text-muted-foreground">
                    No models match these filters.
                  </p>
                )}
              </div>
              <nav aria-label="Models pages" className="flex items-center justify-end gap-2">
                <button
                  className="rounded-control px-3 py-1.5 text-ui-meta text-muted-foreground hover:bg-muted disabled:opacity-50"
                  disabled={modelOffset === 0}
                  onClick={() => {
                    setModelOffset(Math.max(0, modelOffset - modelLimit));
                  }}
                  type="button"
                >
                  Previous
                </button>
                <button
                  className="rounded-control px-3 py-1.5 text-ui-meta text-muted-foreground hover:bg-muted disabled:opacity-50"
                  disabled={modelOffset + effectiveModelLimit >= modelTotal}
                  onClick={() => {
                    setModelOffset(modelOffset + effectiveModelLimit);
                  }}
                  type="button"
                >
                  Next
                </button>
              </nav>
            </Section>
          </UiV2.TabsContent>
          <UiV2.TabsContent value="usage">
            <UsageTab />
          </UiV2.TabsContent>
          <UiV2.TabsContent value="health">
            <HealthTab />
          </UiV2.TabsContent>
        </UiV2.Tabs>
      </div>
      <UiV2.Dialog onOpenChange={closeDialog} open={dialogOpen && dialogMode === 'add'}>
        <UiV2.DialogContent
          aria-describedby="provider-dialog-description"
          className="max-h-[80vh] max-w-[480px] overflow-auto"
        >
          <header className="flex items-start gap-3">
            <div className="mr-auto grid gap-2">
              <UiV2.DialogTitle>Add a provider</UiV2.DialogTitle>
              <UiV2.DialogDescription id="provider-dialog-description">
                Choose a provider to configure its connection.
              </UiV2.DialogDescription>
            </div>
            <UiV2.DialogClose aria-label="Close dialog">
              <X aria-hidden="true" />
            </UiV2.DialogClose>
          </header>
          <div className="grid gap-2">
            {providers
              .filter(
                (provider) =>
                  !provider.enabled || (provider.kind === 'api' && provider.keyStatus !== 'valid'),
              )
              .map((provider) => (
                <UiV2.Button
                  className="h-auto w-full justify-start gap-3 rounded-card px-3 py-3 text-left"
                  key={provider.id}
                  onClick={() => {
                    openManage(provider);
                  }}
                  variant="ghost"
                >
                  <ProviderLogo name={provider.name} providerId={provider.id} size={24} />
                  <span className="min-w-0 flex-1">
                    <strong className="block text-ui-label font-medium text-foreground">
                      {provider.name}
                    </strong>
                    <small className="mt-0.5 block whitespace-normal text-left text-ui-meta text-muted-foreground">
                      {provider.termsNote ??
                        provider.dataUse ??
                        (provider.kind === 'cli'
                          ? 'Detected from your installed command line tool.'
                          : 'Add an API key to enable model routing.')}
                    </small>
                  </span>
                  <ArrowUpRight className="text-muted-foreground" size={16} />
                </UiV2.Button>
              ))}
          </div>
        </UiV2.DialogContent>
      </UiV2.Dialog>
      <ProviderKeyDialog
        showRoutingControls
        provider={activeProvider}
        open={dialogMode === 'manage' && Boolean(activeProvider)}
        onOpenChange={(open) => {
          if (!open) setActiveProvider(null);
        }}
      />
      <UiV2.Dialog
        open={activeOAuthProvider?.riskLevel === 'high'}
        onOpenChange={(open) => {
          if (!open) {
            setActiveOAuthProvider(null);
            setRiskAcknowledged(false);
          }
        }}
      >
        <UiV2.DialogContent className="max-w-[520px]">
          <header className="flex items-start gap-3">
            <div className="mr-auto grid gap-2">
              <UiV2.DialogTitle>
                Use your {activeOAuthProvider?.name} subscription outside its official app?
              </UiV2.DialogTitle>
              <UiV2.DialogDescription>
                Logging in here uses your personal subscription through an unofficial client.{' '}
                {activeOAuthProvider?.name} may treat this as a violation of its terms and{' '}
                <strong className="text-warning"> suspend or ban your account</strong>. Ferry cannot
                protect you from that. Official alternatives: use the provider's API key, or
                delegate to its official CLI.
              </UiV2.DialogDescription>
            </div>
            <UiV2.DialogClose aria-label="Close dialog">
              <X aria-hidden="true" />
            </UiV2.DialogClose>
          </header>
          <p className="rounded-card bg-warning/10 p-3 text-ui-meta text-warning">
            Subscription use carries account suspension risk. This warning appears at every login.
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-ui-label">
            <UiV2.Checkbox
              checked={riskAcknowledged}
              id="oauth-risk-acknowledgement"
              onCheckedChange={(checked) => {
                setRiskAcknowledged(checked === true);
              }}
            />
            <span>I understand my account may be suspended</span>
          </label>
          <div className="flex justify-end gap-2">
            <UiV2.Button
              autoFocus
              onClick={() => {
                setActiveOAuthProvider(null);
              }}
              variant="secondary"
            >
              Cancel
            </UiV2.Button>
            <UiV2.Button
              disabled={!riskAcknowledged || oauthLoading}
              onClick={() => {
                void loginOAuth();
              }}
            >
              {oauthLoading ? 'Opening sign-in…' : 'Log in anyway'}
            </UiV2.Button>
          </div>
        </UiV2.DialogContent>
      </UiV2.Dialog>
    </section>
  );
}
