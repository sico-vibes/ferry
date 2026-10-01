import type { Provider } from '@ferry/shared';
import { AlertTriangle, Check, KeyRound } from 'lucide-react';
import { CountUp } from '../data/CountUp';
import { Spotlight } from '../../effects/Spotlight';
import { BrandIcon, Pill } from '../primitives';
import { Switch } from '../forms';
import { LatticeLoader } from '../feedback/LatticeLoader';
import { TagBadge } from './TagBadge';
import { QuotaWindowBar } from './QuotaWindowBar';
import { DataUseBadge } from './DataUseBadge';
import { ShowMoreList } from '../data/ShowMoreList';

export function ProviderCard({
  provider,
  probing = false,
  onTest,
  onManageKey,
  onToggle,
}: {
  provider: Provider;
  probing?: boolean;
  onTest?: () => void;
  onManageKey?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const cooldown = provider.cooldownUntil
    ? Math.max(0, Math.ceil((new Date(provider.cooldownUntil).getTime() - Date.now()) / 1000))
    : 0;
  const terminalHealth =
    provider.health === 'auth_invalid' || provider.health === 'account_disabled';
  const status = terminalHealth
    ? 'Needs attention'
    : provider.health === 'down'
      ? 'Down'
      : provider.health === 'cooldown'
        ? `Cooldown · ${String(cooldown)}s`
        : provider.health === 'unknown'
          ? 'Unknown'
          : 'Available';
  const statusColor =
    terminalHealth || provider.health === 'down'
      ? 'bg-danger'
      : provider.health === 'cooldown'
        ? 'bg-warn'
        : provider.health === 'unknown'
          ? 'bg-text-3'
          : 'bg-success-legacy';
  const keyText = terminalHealth
    ? 'Needs attention: re-enter key'
    : provider.keyStatus === 'valid'
      ? 'Key: valid'
      : provider.keyStatus === 'missing'
        ? 'Key: missing'
        : provider.keyStatus === 'invalid'
          ? 'Key: invalid'
          : provider.keyStatus === 'not_applicable'
            ? 'No key needed (CLI)'
            : 'Key: unchecked';
  const displayName = provider.name.replace(/ Inference \(Free Trial.*\)$/i, '');
  const trialNote = /free trial/i.test(provider.name)
    ? 'Free trial uses provider credits; availability depends on the account.'
    : null;
  return (
    <Spotlight
      className={`h-full rounded-card border border-border-hair bg-card p-4 shadow-[inset_0_1px_0_var(--highlight-top)] ${provider.enabled ? '' : 'opacity-60'}`}
    >
      <article className="provider-card-content flex h-full min-w-0 flex-col gap-3">
        <header className="flex min-w-0 items-center gap-2.5">
          <BrandIcon
            slug={provider.brand ?? provider.name}
            label={provider.name}
            className="size-8 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="truncate text-label font-semibold text-text-1" title={provider.name}>
                {displayName}
              </h2>
              <TagBadge
                kind={
                  provider.tag === 'subscription_cli'
                    ? 'cli'
                    : provider.tag === 'subscription_oauth'
                      ? 'subscription_oauth'
                      : provider.tag
                }
              />
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-meta text-text-2">
              <span className={`size-1.5 rounded-full ${statusColor}`} />
              {status}
            </p>
          </div>
          <Switch
            label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
            checked={provider.enabled}
            onCheckedChange={(enabled) => onToggle?.(enabled)}
          />
        </header>
        {provider.tag === 'promo' && (
          <p className="text-meta text-warn">Promotional — may end without notice.</p>
        )}
        {trialNote && <p className="text-meta text-text-2">{trialNote}</p>}
        <p
          className={`flex items-center gap-1.5 text-meta ${provider.keyStatus === 'invalid' ? 'text-danger' : provider.keyStatus === 'valid' ? 'text-success-legacy' : 'text-text-2'}`}
        >
          {provider.keyStatus === 'valid' ? <Check size={13} /> : <KeyRound size={13} />}
          {keyText}
        </p>
        <ShowMoreList
          items={provider.windows}
          groupKey={`provider-card:${provider.id}:quota-windows`}
          initialCount={3}
          label="quota windows"
          renderItem={(window) => (
            <li className="list-none" key={window.id}>
              <QuotaWindowBar window={window} />
            </li>
          )}
        />
        {provider.windows.length === 0 && (
          <p className="text-meta text-text-2">Quota reported by provider when available</p>
        )}
        {provider.availableModels && provider.availableModels.length > 0 && (
          <details className="text-meta text-text-2">
            <summary className="cursor-pointer py-1">
              Models <span className="text-text-3">{provider.availableModels.length}</span>
            </summary>
            <ShowMoreList
              items={provider.availableModels}
              groupKey={`provider-card:${provider.id}:models`}
              label="models"
              renderItem={(model) => (
                <li className="truncate text-text-2" key={model.ref} title={model.name}>
                  {model.name}
                </li>
              )}
            />
          </details>
        )}
        {
          <p className="flex flex-wrap items-start gap-1.5 text-[11px] leading-4 text-text-2">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            <DataUseBadge dataUse={provider.dataUse} />
            {provider.dataUse && <span>{provider.dataUse}</span>}
          </p>
        }
        <footer className="provider-card-footer mt-auto grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-t border-border-hair pt-2.5">
          <span className="truncate text-meta text-text-2" title="Rate-limited · no daily cap">
            {provider.stepsLeftToday === null ? (
              'Rate-limited · no daily cap'
            ) : (
              <>
                ≈ <CountUp to={provider.stepsLeftToday} /> steps today
              </>
            )}
          </span>
          <Pill
            aria-label={`Test ${provider.name}`}
            disabled={probing || !provider.enabled}
            onClick={onTest}
            size="sm"
            variant="outline"
          >
            {probing ? <LatticeLoader label="Testing" /> : null}
            {probing ? 'Testing…' : 'Test'}
          </Pill>
          <Pill onClick={onManageKey} size="sm" variant="blue-tint">
            Manage key
          </Pill>
        </footer>
      </article>
    </Spotlight>
  );
}
