import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Dialog } from 'radix-ui';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, Search, X } from 'lucide-react';
import type { OAuthProvider, Provider } from '@ferry/shared';
import {
  BrandIcon,
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  ProviderCard,
  Section,
  Skeleton,
  Stack,
} from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { useToasts } from '../../state/toasts';
import { useUI } from '../../state/ui';
import { ProviderKeyDialog } from '../ProviderKeyDialog';

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
const providerKinds = (provider: Provider) =>
  provider.tag === 'subscription_cli' ? 'CLI' : provider.tag === 'paid' ? 'Paid' : 'Free';
const compact = (value: number | null) =>
  value === null ? '—' : value === 0 ? 'Free' : `$${value.toFixed(2)}`;

export function ExploreCanvas() {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const filter = useUI((state) => state.exploreFilter);
  const [search, setSearch] = useState('');
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
  const {
    data: providers = [],
    isLoading: providersLoading,
    isError: providersError,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => client.models.list(),
  });
  const { data: oauthProviders = [] } = useQuery({
    queryKey: ['oauth-providers'],
    queryFn: () => client.oauth.list(),
  });
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => client.settings.get(),
  });

  useEffect(() => {
    const off = client.on('provider.updated', (provider) => {
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
  const visibleProviders = providers.filter((provider) => {
    const query = search.trim().toLowerCase();
    return (
      (filter === 'All' || providerKinds(provider) === filter) &&
      (!query || provider.name.toLowerCase().includes(query) || provider.id.includes(query))
    );
  });
  const visibleModels = useMemo(() => {
    const names = new Map(providers.map((provider) => [provider.id, provider.name]));
    return models
      .filter(
        (model) =>
          (modelTier === 'All tiers' || model.tier === modelTier) &&
          (modelKind === 'All' || (modelKind === 'Free' ? model.free : !model.free)),
      )
      .toSorted((left, right) => {
        const a = left[sort.key];
        const b = right[sort.key];
        let result: number;
        if (sort.key === 'providerId')
          result = (names.get(left.providerId) ?? left.providerId).localeCompare(
            names.get(right.providerId) ?? right.providerId,
          );
        else if (typeof a === 'string' && typeof b === 'string') result = a.localeCompare(b);
        else result = Number(a ?? -1) - Number(b ?? -1);
        return sort.ascending ? result : -result;
      });
  }, [modelKind, modelTier, models, providers, sort]);

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
    setProbing(provider.id);
    try {
      const result = await client.providers.probe(provider.id);
      pushToast({
        kind: result.ok ? 'success' : 'error',
        title: result.ok
          ? `Connected · ${result.latencyMs === null ? 'CLI' : String(result.latencyMs)}${result.latencyMs === null ? '' : ' ms'}`
          : 'Key invalid',
        body: result.ok ? provider.name : result.message,
      });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Provider test failed',
        body: error instanceof Error ? error.message : 'Try again.',
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
  };
  const sortLabel = (key: ModelSort, label: string) => (
    <button
      aria-label={`Sort by ${label}`}
      className="inline-flex items-center gap-1 text-left hover:text-text-1"
      onClick={() => {
        sortModels(key);
      }}
      type="button"
    >
      {label}
      {sort.key === key ? sort.ascending ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}
    </button>
  );
  const loginOAuth = async () => {
    if (!activeOAuthProvider || !riskAcknowledged) return;
    setOauthLoading(true);
    try {
      const acknowledged = settings?.subscriptionOAuthAcknowledged ?? [];
      if (!acknowledged.includes(activeOAuthProvider.id))
        await client.settings.update({
          subscriptionOAuthAcknowledged: [...acknowledged, activeOAuthProvider.id],
        });
      await client.oauth.login(activeOAuthProvider.id);
      await cache.invalidateQueries({ queryKey: ['oauth-providers'] });
      pushToast({
        kind: 'success',
        title: 'Subscription login complete',
        body: activeOAuthProvider.name,
      });
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

  return (
    <section
      aria-label="Explore providers and models"
      className="canvas page-scroll-canvas min-h-0 p-5"
    >
      <Stack className="page-content mx-auto w-full max-w-[1200px]" gap={4}>
        <PageHeader
          title="Providers"
          subtitle="Free tiers, paid plans and CLIs Ferry can route to"
          nav={
            <nav aria-label="Explore sections" className="flex gap-1">
              <Pill
                className="border-border-strong bg-raised"
                onClick={() => void navigate({ to: '/explore' })}
                size="sm"
                variant="outline"
              >
                Providers
              </Pill>
              <Pill
                onClick={() => void navigate({ to: '/explore/usage' })}
                size="sm"
                variant="outline"
              >
                Usage
              </Pill>
            </nav>
          }
          actions={
            <>
              <label className="flex h-9 w-[min(250px,100%)] items-center gap-2 rounded-input border border-border-soft bg-input px-3 text-text-3">
                <Search size={15} />
                <input
                  aria-label="Search providers"
                  className="min-w-0 flex-1 bg-transparent text-label text-text-1 outline-none placeholder:text-text-3"
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                  placeholder="Search providers"
                  value={search}
                />
                {search && (
                  <button
                    aria-label="Clear provider search"
                    onClick={() => {
                      setSearch('');
                    }}
                    type="button"
                  >
                    <X size={14} />
                  </button>
                )}
              </label>
              <Pill
                leadingIcon={<span aria-hidden="true">+</span>}
                onClick={openAdd}
                size="lg"
                variant="blue-tint"
              >
                Add provider
              </Pill>
            </>
          }
        />
        <section aria-label="Provider filter" className="flex flex-wrap items-center gap-2">
          {(['All', 'Free', 'Paid', 'CLI'] as const).map((item) => (
            <button
              aria-pressed={filter === item}
              className={`rounded-pill border px-3 py-1.5 text-label transition ${filter === item ? 'border-border-strong bg-raised text-text-1' : 'border-border-hair text-text-2 hover:bg-icon-circle'}`}
              key={item}
              onClick={() => {
                useUI.getState().setExploreFilter(item);
              }}
              type="button"
            >
              {item}
            </button>
          ))}
          <span className="ml-auto text-meta text-text-3">{visibleProviders.length} providers</span>
        </section>
        {providersLoading ? (
          <Skeleton rows={4} />
        ) : providersError ? (
          <ErrorState
            title="Provider list could not load"
            action="Retry"
            onAction={() => void refetchProviders()}
          />
        ) : visibleProviders.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3">
            {visibleProviders.map((provider) => (
              <div id={`provider-${provider.id}`} key={provider.id}>
                <ProviderCard
                  onManageKey={() => {
                    openManage(provider);
                  }}
                  onTest={() => void probe(provider)}
                  onToggle={(enabled) => void toggleProvider(provider, enabled)}
                  probing={probing === provider.id}
                  provider={provider}
                />
                {provider.health === 'down' && (
                  <ErrorState
                    title={`${provider.name} probe failed`}
                    action="Review provider"
                    onAction={() => {
                      openManage(provider);
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        ) : providers.length === 0 ? (
          <EmptyState title="No providers connected" action="Add a provider" onAction={openAdd} />
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
        <Section
          title="Subscription logins (unofficial)"
          className="border border-warn/30 bg-warn/5"
        >
          <details>
            <summary className="cursor-pointer text-label font-medium text-warn">
              Optional subscription sign-in · account suspension risk
            </summary>
            <p className="my-3 text-body text-text-2">
              Unofficial clients may violate provider terms. Your account could be suspended or
              banned. Use an API key or the provider’s official CLI for supported access.
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-2">
              {oauthProviders.map((provider) => (
                <article
                  className="rounded-card border border-warn/20 bg-card p-3"
                  key={provider.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-label text-text-1">{provider.name}</strong>
                    <span className="rounded-pill bg-warn/10 px-2 py-1 text-meta text-warn">
                      Unofficial · high risk
                    </span>
                  </div>
                  <p className="my-2 text-meta text-text-3">{provider.models.join(' · ')}</p>
                  <p className="text-meta text-warn">Account suspension or ban is possible.</p>
                  <Pill
                    className="mt-3"
                    onClick={() => {
                      setActiveOAuthProvider(provider);
                      setRiskAcknowledged(
                        settings?.subscriptionOAuthAcknowledged.includes(provider.id) ?? false,
                      );
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {provider.connected ? 'Manage login' : 'Log in'}
                  </Pill>
                </article>
              ))}
            </div>
          </details>
        </Section>
        <Section title="Models" ariaLabel="Models" className="grid gap-3">
          <header className="flex flex-wrap items-end gap-3">
            <div className="mr-auto">
              <p className="text-meta text-text-3">Compare capabilities and published pricing</p>
            </div>
            <div aria-label="Filter by tier" className="flex gap-1">
              {modelFilters.map((item) => (
                <button
                  aria-pressed={modelTier === item}
                  className={`rounded-pill px-2.5 py-1 text-meta ${modelTier === item ? 'bg-raised text-text-1' : 'text-text-3 hover:text-text-2'}`}
                  key={item}
                  onClick={() => {
                    setModelTier(item);
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
                  className={`rounded-pill px-2.5 py-1 text-meta ${modelKind === item ? 'bg-raised text-text-1' : 'text-text-3 hover:text-text-2'}`}
                  key={item}
                  onClick={() => {
                    setModelKind(item);
                  }}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </header>
          <div
            className="model-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Model comparison table, scroll horizontally for more columns"
          >
            <table className="w-full min-w-[760px] border-collapse text-left text-meta">
              <thead className="bg-panel text-text-3">
                <tr className="h-9 border-b border-border-hair">
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
                    className="h-10 border-b border-border-hair last:border-0 hover:bg-icon-circle"
                    key={model.ref}
                  >
                    <td
                      className="max-w-56 truncate px-3 font-medium text-text-1"
                      title={model.name}
                    >
                      {model.name}
                      {oauthProviders.some((provider) => model.providerId === provider.id) && (
                        <span
                          className="ml-2 rounded-pill bg-warn/10 px-2 py-0.5 text-meta text-warn"
                          title="Unofficial subscription access may lead to account suspension"
                        >
                          Subscription OAuth · risk
                        </span>
                      )}
                    </td>
                    <td className="px-3 text-text-2">
                      {providerNames[model.providerId] ?? model.providerId}
                    </td>
                    <td className="px-3">
                      <span className="rounded-pill bg-raised px-2 py-1 text-text-2">
                        {model.tier}
                      </span>
                    </td>
                    <td className="px-3 tabular-nums text-text-2">
                      {new Intl.NumberFormat().format(model.contextWindow)}
                    </td>
                    <td className="px-3">
                      {model.toolCalling ? (
                        <Check aria-label="Tools supported" className="text-success" size={14} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 text-text-2">{model.free ? 'Free' : 'Paid'}</td>
                    <td className="px-3 tabular-nums text-text-2">{compact(model.priceInPerM)}</td>
                    <td className="px-3 tabular-nums text-text-2">{compact(model.priceOutPerM)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleModels.length === 0 && (
              <p className="p-5 text-center text-body text-text-3">
                No models match these filters.
              </p>
            )}
          </div>
        </Section>
      </Stack>
      <Dialog.Root onOpenChange={closeDialog} open={dialogOpen && dialogMode === 'add'}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-app/80 backdrop-blur-[2px]" />
          <Dialog.Content
            aria-describedby="provider-dialog-description"
            className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[min(480px,calc(100vw-40px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-card border border-border-soft bg-panel p-5 shadow-[var(--highlight-top)] focus:outline-none"
          >
            <header className="mb-4 flex items-start gap-3">
              <div className="mr-auto">
                <Dialog.Title className="text-title font-semibold text-text-1">
                  Add a provider
                </Dialog.Title>
                <Dialog.Description
                  className="mt-1 text-label text-text-2"
                  id="provider-dialog-description"
                >
                  Choose a provider to configure its connection.
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="Close dialog"
                className="rounded-pill p-1.5 text-text-3 hover:bg-raised hover:text-text-1"
              >
                <X size={16} />
              </Dialog.Close>
            </header>
            <div className="grid gap-2">
              {providers
                .filter(
                  (provider) =>
                    !provider.enabled ||
                    (provider.kind === 'api' && provider.keyStatus !== 'valid'),
                )
                .map((provider) => (
                  <button
                    className="flex items-center gap-3 rounded-card border border-border-hair bg-card p-3 text-left hover:border-border-strong"
                    key={provider.id}
                    onClick={() => {
                      openManage(provider);
                    }}
                    type="button"
                  >
                    <BrandIcon label={provider.name} slug={provider.brand ?? provider.name} />
                    <span className="min-w-0 flex-1">
                      <strong className="block text-label font-medium text-text-1">
                        {provider.name}
                      </strong>
                      <small className="mt-0.5 block text-meta text-text-3">
                        {provider.termsNote ??
                          provider.dataUse ??
                          (provider.kind === 'cli'
                            ? 'Detected from your installed command line tool.'
                            : 'Add an API key to enable model routing.')}
                      </small>
                    </span>
                    <ArrowUpRight className="text-text-3" size={15} />
                  </button>
                ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ProviderKeyDialog
        provider={activeProvider}
        open={dialogMode === 'manage' && Boolean(activeProvider)}
        onOpenChange={(open) => {
          if (!open) setActiveProvider(null);
        }}
      />
      <Dialog.Root
        open={Boolean(activeOAuthProvider)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveOAuthProvider(null);
            setRiskAcknowledged(false);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-app/80 backdrop-blur-[2px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-warn/35 bg-panel p-5 shadow-[var(--highlight-top)] focus:outline-none">
            <Dialog.Title className="text-title font-semibold text-text-1">
              Use your {activeOAuthProvider?.name} subscription outside its official app?
            </Dialog.Title>
            <Dialog.Description className="mt-3 text-body text-text-2">
              Logging in here uses your personal subscription through an unofficial client.{' '}
              {activeOAuthProvider?.name} may treat this as a violation of its terms and{' '}
              <strong className="text-warn"> suspend or ban your account</strong>. Ferry cannot
              protect you from that. Official alternatives: use the provider's API key, or delegate
              to its official CLI.
            </Dialog.Description>
            <p className="mt-3 rounded-card border border-warn/25 bg-warn/5 p-3 text-meta text-warn">
              Subscription use carries account suspension risk. This warning appears at every login.
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-label text-text-1">
              <input
                checked={riskAcknowledged}
                onChange={(event) => {
                  setRiskAcknowledged(event.currentTarget.checked);
                }}
                type="checkbox"
              />
              <span>I understand my account may be suspended</span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <Pill
                autoFocus
                onClick={() => {
                  setActiveOAuthProvider(null);
                }}
                size="sm"
                variant="outline"
              >
                Cancel
              </Pill>
              <Pill
                disabled={!riskAcknowledged || oauthLoading}
                onClick={() => {
                  void loginOAuth();
                }}
                size="sm"
                variant="blue-tint"
              >
                {oauthLoading ? 'Opening sign-in…' : 'Log in anyway'}
              </Pill>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
