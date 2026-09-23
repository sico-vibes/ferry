import type { Provider } from '@ferry/shared';
import { AlertTriangle, Check, KeyRound } from 'lucide-react';
import { CountUp } from '../data/CountUp';
import { Spotlight } from '../../effects/Spotlight';
import { BrandIcon, Pill } from '../primitives';
import { LatticeLoader } from '../feedback/LatticeLoader';
import { TagBadge } from './TagBadge';
import { QuotaWindowBar } from './QuotaWindowBar';

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
  const status =
    provider.health === 'down'
      ? 'Down'
      : provider.health === 'cooldown'
        ? `Cooldown · ${String(cooldown)}s`
        : provider.health === 'unknown'
          ? 'Unknown'
          : 'Available';
  const statusColor =
    provider.health === 'down'
      ? 'bg-danger'
      : provider.health === 'cooldown'
        ? 'bg-warn'
        : 'bg-success';
  const keyText =
    provider.keyStatus === 'valid'
      ? 'Key: valid'
      : provider.keyStatus === 'missing'
        ? 'Key: missing'
        : provider.keyStatus === 'invalid'
          ? 'Key: invalid'
          : provider.keyStatus === 'not_applicable'
            ? 'No key needed (CLI)'
            : 'Key: unchecked';
  return (
    <Spotlight
      className={`rounded-card border border-border-hair bg-card p-3.5 shadow-[inset_0_1px_0_var(--highlight-top)] ${provider.enabled ? '' : 'opacity-60'}`}
    >
      <article className="grid gap-3">
        <header className="flex min-w-0 items-center gap-2.5">
          <BrandIcon
            slug={provider.brand ?? provider.name}
            label={provider.name}
            className="size-8 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h2 className="truncate text-label font-semibold text-text-1">{provider.name}</h2>
              <TagBadge kind={provider.tag === 'subscription_cli' ? 'cli' : provider.tag} />
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-meta text-text-3">
              <span className={`size-1.5 rounded-full ${statusColor}`} />
              {status}
            </p>
          </div>
          <button
            aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
            aria-pressed={provider.enabled}
            className={`relative h-5 w-9 rounded-pill border transition ${provider.enabled ? 'border-blue-500/40 bg-blue-tint' : 'border-border-soft bg-raised'}`}
            onClick={() => onToggle?.(!provider.enabled)}
            role="switch"
            type="button"
          >
            <span
              className={`absolute top-0.5 size-3.5 rounded-full bg-text-1 transition ${provider.enabled ? 'left-[18px]' : 'left-0.5'}`}
            />
          </button>
        </header>
        <p
          className={`flex items-center gap-1.5 text-meta ${provider.keyStatus === 'invalid' ? 'text-danger' : provider.keyStatus === 'valid' ? 'text-success' : 'text-text-2'}`}
        >
          {provider.keyStatus === 'valid' ? <Check size={13} /> : <KeyRound size={13} />}
          {keyText}
        </p>
        {provider.windows.slice(0, 3).map((window) => (
          <QuotaWindowBar key={window.id} window={window} />
        ))}
        {provider.windows.length === 0 && (
          <p className="text-meta text-text-3">Quota reported by provider when available</p>
        )}
        {provider.dataUse && (
          <p className="flex items-start gap-1.5 text-[11px] leading-4 text-text-3">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            {provider.dataUse}
          </p>
        )}
        <footer className="flex flex-wrap items-center gap-2 border-t border-border-hair pt-2.5">
          <span className="mr-auto text-meta text-text-2">
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
