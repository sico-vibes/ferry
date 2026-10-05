import { useMemo, useState } from 'react';
import type { Provider, QuotaWindow } from '@ferry/shared';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Info,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Power,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import {
  dataUseStatus,
  formatQuotaValue,
  ProviderLogo,
  TagBadge,
  type TagBadgeKind,
  UiV2,
} from '@ferry/ui';

type SortKey = 'name' | 'status' | 'usage';
type Tone = 'success' | 'warning' | 'destructive' | 'muted';

/** The single status a row shows, most urgent first. */
export function providerStatus(
  provider: Provider,
  now = Date.now(),
): { label: string; tone: Tone } {
  if (!provider.enabled) return { label: 'Off', tone: 'muted' };
  if (provider.health === 'auth_invalid' || provider.keyStatus === 'invalid')
    return { label: 'Invalid key', tone: 'destructive' };
  if (provider.health === 'account_disabled')
    return { label: 'Account disabled', tone: 'destructive' };
  if (provider.health === 'down') return { label: 'Unavailable', tone: 'destructive' };
  if (provider.health === 'cooldown') {
    const ms = provider.cooldownUntil ? Date.parse(provider.cooldownUntil) - now : 0;
    if (ms <= 0) return { label: 'Cooling down', tone: 'warning' };
    const minutes = Math.ceil(ms / 60_000);
    return {
      label: `Cooldown ${minutes >= 60 ? `${String(Math.floor(minutes / 60))}h` : `${String(minutes)}m`}`,
      tone: 'warning',
    };
  }
  if (provider.keyStatus === 'missing') return { label: 'Key missing', tone: 'muted' };
  if (provider.keyStatus === 'unchecked') return { label: 'Not checked', tone: 'muted' };
  if (provider.health === 'unknown')
    return provider.keyStatus === 'valid'
      ? { label: 'Key valid', tone: 'success' }
      : { label: 'Unknown', tone: 'muted' };
  return { label: 'Healthy', tone: 'success' };
}

const statusRank: Record<Tone, number> = { destructive: 0, warning: 1, success: 2, muted: 3 };

function statusIcon(label: string): LucideIcon {
  if (label === 'Healthy' || label === 'Key valid') return CircleCheck;
  if (label.startsWith('Cool')) return Timer;
  if (label === 'Invalid key' || label === 'Key missing') return KeyRound;
  if (label === 'Account disabled') return Ban;
  if (label === 'Unavailable') return CircleX;
  if (label === 'Not checked') return CircleDashed;
  if (label === 'Off') return Power;
  return CircleHelp;
}

/** The most constrained quota window with a known limit. */
function tightestWindow(provider: Provider): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const window of provider.windows) {
    if (window.limit === null || window.limit === 0) continue;
    if (!best || window.used / window.limit > best.used / (best.limit ?? 1)) best = window;
  }
  return best;
}

function tagKind(provider: Provider): TagBadgeKind {
  if (provider.tag === 'subscription_cli') return 'cli';
  return provider.tag;
}

const metricLabel: Record<QuotaWindow['metric'], string> = {
  requests: 'req',
  tokens: 'tok',
  usd: '',
  credits: 'cr',
};

function UsageMeter({ window }: { window: QuotaWindow | null }) {
  const empty = <span className="v2-provider-usage-empty">No published limit</span>;
  if (!window) return empty;
  const { limit } = window;
  if (limit === null) return empty;
  const percent = Math.min(100, (window.used / limit) * 100);
  const filled = Math.round(percent / 10);
  const tone = percent >= 100 ? 'destructive' : percent >= 80 ? 'warning' : 'primary';
  const period = window.periodLabel.replace(/^per\s+/i, '/');
  return (
    <span
      aria-label={`${String(Math.round(percent))}% of ${window.metric} ${window.periodLabel} used`}
      className="v2-provider-usage"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <span aria-hidden="true" className="v2-provider-usage-bars" data-tone={tone}>
        {Array.from({ length: 10 }, (_, index) => (
          <span data-on={index < filled} key={index} />
        ))}
      </span>
      <span className="v2-provider-usage-value">
        {formatQuotaValue(window.used, window.metric)}
        <span> / {formatQuotaValue(limit, window.metric)}</span>
        <span className="v2-provider-usage-period">
          {' '}
          {metricLabel[window.metric]}
          {period}
        </span>
      </span>
    </span>
  );
}

export function ProvidersTable({
  providers,
  testing,
  onTest,
  onManage,
  onToggle,
  feedback,
  emptyLabel = 'No providers',
}: {
  providers: Provider[];
  testing?: string | null;
  /** Latest connection-test result per provider id. */
  feedback?: Record<string, string | undefined>;
  onTest: (provider: Provider) => void;
  onManage: (provider: Provider) => void;
  onToggle: (provider: Provider, enabled: boolean) => void;
  emptyLabel?: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return providers;
    const direction = sort.ascending ? 1 : -1;
    const usage = (provider: Provider) => {
      const window = tightestWindow(provider);
      return window?.limit ? window.used / window.limit : -1;
    };
    return [...providers].sort((a, b) => {
      if (sort.key === 'name') return direction * a.name.localeCompare(b.name);
      if (sort.key === 'status')
        return (
          direction *
          (statusRank[providerStatus(a).tone] - statusRank[providerStatus(b).tone] ||
            a.name.localeCompare(b.name))
        );
      return direction * (usage(a) - usage(b));
    });
  }, [providers, sort]);
  const header = (key: SortKey, label: string) => (
    <button
      className="v2-table-sort"
      onClick={() => {
        setSort((current) =>
          current?.key === key ? { key, ascending: !current.ascending } : { key, ascending: true },
        );
      }}
      type="button"
    >
      {label}
      {sort?.key === key &&
        (sort.ascending ? (
          <ArrowUp aria-hidden="true" size={12} />
        ) : (
          <ArrowDown aria-hidden="true" size={12} />
        ))}
    </button>
  );
  const ariaSort = (key: SortKey) =>
    sort?.key === key ? (sort.ascending ? 'ascending' : 'descending') : undefined;
  return (
    <UiV2.TooltipProvider delayDuration={0}>
      <div className="v2-providers-table-wrap">
        <table aria-label="Providers" className="v2-providers-table">
          <thead>
            <tr>
              <th aria-sort={ariaSort('name')} scope="col">
                {header('name', 'Provider')}
              </th>
              <th aria-sort={ariaSort('status')} className="v2-col-status" scope="col">
                {header('status', 'Status')}
              </th>
              <th aria-sort={ariaSort('usage')} className="v2-col-usage" scope="col">
                {header('usage', 'Usage')}
              </th>
              <th className="v2-col-data" scope="col">
                Data use
              </th>
              <th className="v2-col-enabled" scope="col">
                <span className="sr-only">Enabled</span>
              </th>
              <th className="v2-col-actions" scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((provider) => {
              const status = providerStatus(provider);
              const StatusIcon = statusIcon(status.label);
              const training = dataUseStatus(provider.dataUse);
              const note = provider.termsNote ?? provider.dataUse;
              const toggleable = provider.tag !== 'subscription_oauth';
              return (
                <tr
                  data-enabled={provider.enabled}
                  id={`provider-${provider.id}`}
                  key={provider.id}
                >
                  <td>
                    <span className="v2-provider-cell">
                      <ProviderLogo name={provider.name} providerId={provider.id} size={20} />
                      <span className="v2-provider-name" title={provider.name}>
                        {provider.name}
                      </span>
                      <TagBadge kind={tagKind(provider)} />
                      {note && (
                        <UiV2.Tooltip>
                          <UiV2.TooltipTrigger asChild>
                            <button
                              aria-label={`About ${provider.name}`}
                              className="v2-provider-info"
                              type="button"
                            >
                              <Info aria-hidden="true" size={14} />
                            </button>
                          </UiV2.TooltipTrigger>
                          <UiV2.TooltipContent className="v2-provider-tooltip" side="top">
                            {note}
                          </UiV2.TooltipContent>
                        </UiV2.Tooltip>
                      )}
                    </span>
                  </td>
                  <td className="v2-col-status">
                    <UiV2.Tooltip>
                      <UiV2.TooltipTrigger asChild>
                        <span className="v2-status-icon" data-tone={status.tone} tabIndex={0}>
                          <StatusIcon aria-hidden="true" size={16} strokeWidth={1.9} />
                          <span className="sr-only">{status.label}</span>
                        </span>
                      </UiV2.TooltipTrigger>
                      <UiV2.TooltipContent side="top">
                        {status.label}
                        {feedback?.[provider.id] ? ` · ${feedback[provider.id] ?? ''}` : ''}
                      </UiV2.TooltipContent>
                    </UiV2.Tooltip>
                    {feedback?.[provider.id] && (
                      <span aria-live="polite" className="sr-only" role="status">
                        {feedback[provider.id]}
                      </span>
                    )}
                  </td>
                  <td className="v2-col-usage">
                    <UsageMeter window={tightestWindow(provider)} />
                  </td>
                  <td className="v2-col-data">
                    <span className="v2-data-use" data-status={training}>
                      {training === 'training'
                        ? 'May train'
                        : training === 'no-training'
                          ? 'No training'
                          : 'Unknown'}
                    </span>
                  </td>
                  <td className="v2-col-enabled">
                    <UiV2.Switch
                      aria-label={`Enable ${provider.name}`}
                      checked={provider.enabled}
                      disabled={!toggleable}
                      onCheckedChange={(enabled) => {
                        onToggle(provider, enabled);
                      }}
                    />
                  </td>
                  <td className="v2-col-actions">
                    <span className="v2-row-actions">
                      <UiV2.Tooltip>
                        <UiV2.TooltipTrigger asChild>
                          <UiV2.Button
                            aria-label={`Test ${provider.name}`}
                            disabled={testing === provider.id || !provider.enabled}
                            onClick={() => {
                              onTest(provider);
                            }}
                            size="icon"
                            variant="ghost"
                          >
                            {testing === provider.id ? (
                              <LoaderCircle aria-hidden="true" className="animate-spin" />
                            ) : (
                              <PlugZap aria-hidden="true" />
                            )}
                          </UiV2.Button>
                        </UiV2.TooltipTrigger>
                        <UiV2.TooltipContent>Test connection</UiV2.TooltipContent>
                      </UiV2.Tooltip>
                      <UiV2.Button
                        aria-label="Manage key"
                        className="v2-manage-key"
                        onClick={() => {
                          onManage(provider);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        <KeyRound aria-hidden="true" />
                        <span className="v2-manage-label">Manage key</span>
                      </UiV2.Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="v2-providers-empty">{emptyLabel}</p>}
      </div>
    </UiV2.TooltipProvider>
  );
}
