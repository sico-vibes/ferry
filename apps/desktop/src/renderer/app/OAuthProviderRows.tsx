import { useMemo, useState } from 'react';
import {
  ExternalLink,
  KeyRound,
  LogIn,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { OAuthProvider } from '@ferry/shared';
import { ShowMoreList } from '@ferry/ui';

const groupLabels = [
  ['official', 'Official OAuth'],
  ['subscription', 'Subscription (unofficial)'],
  ['gateway', 'Gateways'],
  ['coming_soon', 'Coming soon'],
  ['unavailable', 'Unavailable'],
] as const;

function validGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function OAuthProviderRows({
  providers,
  onLogin,
  onLogout,
}: {
  providers: OAuthProvider[];
  onLogin: (provider: OAuthProvider, gateway?: string) => void;
  onLogout: (provider: OAuthProvider) => void;
}) {
  const [query, setQuery] = useState('');
  const [gateways, setGateways] = useState<Record<string, string>>({});
  const visible = useMemo(() => {
    const value = query.trim().toLowerCase();
    return providers.filter(
      (provider) =>
        !value ||
        provider.name.toLowerCase().includes(value) ||
        provider.id.includes(value) ||
        provider.models.some((model) => model.toLowerCase().includes(value)),
    );
  }, [providers, query]);
  return (
    <div className="grid gap-3">
      <label className="flex h-9 items-center gap-2 rounded-control border border-input bg-background px-3 text-muted-foreground">
        <Search aria-hidden="true" size={15} />
        <input
          aria-label="Filter OAuth logins"
          className="min-w-0 flex-1 bg-transparent text-ui-body text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Filter providers"
          type="search"
          value={query}
        />
      </label>
      {groupLabels.map(([group, title]) => {
        const rows = visible.filter((provider) => (provider.group ?? 'subscription') === group);
        if (!rows.length) return null;
        return (
          <details className="pb-3" key={group} open>
            <summary className="cursor-pointer py-1 text-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {title} <span className="ml-1 text-ui-meta text-muted-foreground">{rows.length}</span>
            </summary>
            <ShowMoreList
              items={rows}
              groupKey={`oauth:${group}`}
              label="providers"
              ariaLabel={title}
              listClassName="mt-2 grid gap-2"
              renderItem={(provider) => {
                const status =
                  provider.status ?? (provider.connected ? 'connected' : 'not_connected');
                const available = provider.actionAvailable !== false;
                return (
                  <li
                    className="grid min-h-[52px] grid-cols-[minmax(150px,1.5fr)_minmax(130px,1fr)_minmax(90px,.7fr)_auto] items-center gap-3 rounded-card bg-card px-3 py-2 max-sm:grid-cols-[1fr_auto]"
                    key={provider.id}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <KeyRound
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground"
                        size={16}
                      />
                      <div className="min-w-0">
                        <strong className="block truncate text-ui-label text-foreground">
                          {provider.name}
                        </strong>
                        <span
                          className="block truncate text-ui-meta text-muted-foreground"
                          title={provider.riskText}
                        >
                          {provider.models.length}{' '}
                          {provider.models.length === 1 ? 'model' : 'models'}
                          {provider.advanced ? ', Advanced' : ''}
                          {group === 'unavailable' ? `, ${provider.riskText}` : ''}
                        </span>
                      </div>
                    </div>
                    <span className="truncate text-ui-meta text-muted-foreground">
                      {status === 'expired'
                        ? 'Expired'
                        : provider.connected
                          ? `Connected${provider.account ? ` as ${provider.account}` : ''}`
                          : group === 'unavailable'
                            ? 'Unavailable'
                            : group === 'coming_soon'
                              ? 'Coming soon'
                              : 'Not connected'}
                    </span>
                    <span
                      className={`w-fit rounded-full px-2 py-1 text-ui-meta ${provider.riskLevel === 'high' ? 'bg-warning/10 text-warning' : provider.riskLevel === 'medium' ? 'bg-muted text-muted-foreground' : 'bg-success/10 text-success'}`}
                      aria-label={`${provider.riskLevel} risk`}
                    >
                      {provider.riskLevel} risk
                    </span>
                    <div className="flex items-center justify-end gap-1">
                      {provider.advanced && available && !provider.connected ? (
                        <details className="relative">
                          <summary
                            aria-label={`Configure ${provider.name} gateway`}
                            className="inline-flex h-8 cursor-pointer list-none items-center rounded-control px-2 text-ui-meta text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            Configure…
                          </summary>
                          <div className="absolute right-0 top-full z-20 mt-1 grid w-72 gap-3 rounded-card border border-border bg-card p-3 shadow-[var(--shadow-popover)]">
                            <label className="grid gap-1 text-ui-meta text-muted-foreground">
                              Gateway URL
                              <input
                                aria-label={`${provider.name} gateway URL`}
                                className="h-9 min-w-0 rounded-control border border-input bg-background px-3 text-ui-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onChange={(event) => {
                                  setGateways((current) => ({
                                    ...current,
                                    [provider.id]: event.target.value,
                                  }));
                                }}
                                placeholder="https://gateway.example"
                                type="url"
                                value={gateways[provider.id] ?? ''}
                              />
                            </label>
                            <button
                              aria-label={`Log in to ${provider.name}`}
                              className="inline-flex h-8 items-center justify-center gap-1 rounded-control bg-muted px-3 text-ui-meta text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={!validGatewayUrl(gateways[provider.id] ?? '')}
                              onClick={() => {
                                onLogin(provider, gateways[provider.id]);
                              }}
                              type="button"
                            >
                              <LogIn aria-hidden="true" size={14} /> Log in
                            </button>
                          </div>
                        </details>
                      ) : provider.signupUrl && !available ? (
                        <a
                          aria-label={`Learn about ${provider.name}`}
                          className="inline-flex h-8 items-center gap-1 rounded-control px-2 text-ui-meta text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          href={provider.signupUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Coming soon <ExternalLink aria-hidden="true" size={13} />
                        </a>
                      ) : available ? (
                        <button
                          aria-label={
                            provider.connected
                              ? `Log out of ${provider.name}`
                              : `Log in to ${provider.name}`
                          }
                          className="inline-flex h-8 items-center gap-1 rounded-control px-2 text-ui-meta text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => {
                            if (provider.connected) onLogout(provider);
                            else onLogin(provider, gateways[provider.id]);
                          }}
                          disabled={Boolean(provider.advanced && !gateways[provider.id])}
                          type="button"
                        >
                          {provider.connected ? (
                            <LogOut aria-hidden="true" size={14} />
                          ) : status === 'expired' ? (
                            <RefreshCw aria-hidden="true" size={14} />
                          ) : (
                            <LogIn aria-hidden="true" size={14} />
                          )}
                          {provider.connected
                            ? 'Log out'
                            : status === 'expired'
                              ? 'Refresh'
                              : 'Log in'}
                        </button>
                      ) : (
                        <span className="px-2 text-meta text-text-3">No login action</span>
                      )}
                      <details className="relative">
                        <summary
                          aria-label={`More options for ${provider.name}`}
                          className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <MoreHorizontal aria-hidden="true" size={16} />
                        </summary>
                        <div className="absolute right-0 top-full z-10 mt-1 w-60 rounded-card border border-border bg-card p-3 text-ui-meta text-muted-foreground shadow-[var(--shadow-popover)]">
                          <p>{provider.riskText}</p>
                          {provider.models.length > 0 && (
                            <p className="mt-2 text-muted-foreground">
                              {provider.models.join(', ')}
                            </p>
                          )}
                          {provider.signupUrl && (
                            <a
                              className="mt-2 inline-flex items-center gap-1 text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              href={provider.signupUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Provider site <ExternalLink aria-hidden="true" size={12} />
                            </a>
                          )}
                        </div>
                      </details>
                    </div>
                  </li>
                );
              }}
            />
          </details>
        );
      })}
      {!visible.length && (
        <p className="py-4 text-ui-meta text-muted-foreground">No OAuth providers match.</p>
      )}
    </div>
  );
}
