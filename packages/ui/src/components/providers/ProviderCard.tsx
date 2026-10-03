import type { Provider } from '@ferry/shared';
import { AlertTriangle, Check, KeyRound } from 'lucide-react';
import { CountUp } from '../data/CountUp';
import { BrandIcon } from '../primitives';
import { Button, Switch } from '../ui';
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
  priority = 0,
  weight = 1,
}: {
  provider: Provider;
  probing?: boolean;
  onTest?: () => void;
  onManageKey?: () => void;
  onToggle?: (enabled: boolean) => void;
  priority?: number;
  weight?: number;
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
        ? `Cooldown, ${String(cooldown)}s`
        : provider.health === 'unknown'
          ? 'Unknown'
          : 'Available';
  const statusColor =
    terminalHealth || provider.health === 'down'
      ? 'bg-destructive'
      : provider.health === 'cooldown'
        ? 'bg-warning'
        : provider.health === 'unknown'
          ? 'bg-muted-foreground'
          : 'bg-success';
  const keyStatusText = terminalHealth
    ? 'Needs attention: enter the key again'
    : provider.keyStatus === 'valid'
      ? 'Key valid'
      : provider.keyStatus === 'missing'
        ? 'Key missing'
        : provider.keyStatus === 'invalid'
          ? 'Key invalid'
          : provider.keyStatus === 'not_applicable'
            ? 'No key needed (CLI)'
            : 'Key unchecked';
  const keyText =
    provider.keyCount && provider.keyCount > 1
      ? `${String(provider.keyCount)} keys, ${keyStatusText}`
      : keyStatusText;
  const displayName = provider.name.replace(/ Inference \(Free Trial.*\)$/i, '');
  const trialNote = /free trial/i.test(provider.name)
    ? 'Free trial uses provider credits; availability depends on the account.'
    : null;
  return (
    <div
      className={`provider-card flex h-full flex-col rounded-card bg-card p-5 ${provider.enabled ? '' : 'opacity-60'}`}
    >
      <article className="provider-card-content flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <header className="flex min-w-0 items-center gap-2.5">
          <BrandIcon
            slug={provider.brand ?? provider.name}
            label={provider.name}
            className="size-8 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h2
                className="truncate text-ui-label font-semibold text-foreground"
                title={provider.name}
              >
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
            <p className="mt-0.5 flex items-center gap-1.5 text-ui-meta text-muted-foreground">
              <span className={`size-1.5 rounded-full ${statusColor}`} />
              {status}
            </p>
          </div>
          <Switch
            aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
            checked={provider.enabled}
            onCheckedChange={(enabled) => onToggle?.(enabled)}
          />
        </header>
        {(priority !== 0 || weight !== 1) && (
          <div className="flex flex-wrap gap-1.5" aria-label="Provider routing preferences">
            {priority !== 0 && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-ui-meta text-accent-foreground">
                Priority {priority}
              </span>
            )}
            {weight !== 1 && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-ui-meta text-accent-foreground">
                Weight {weight}
              </span>
            )}
          </div>
        )}
        {provider.tag === 'promo' && (
          <p className="text-ui-meta text-warning">Promotional access may end without notice.</p>
        )}
        {trialNote && <p className="text-ui-meta text-muted-foreground">{trialNote}</p>}
        <p
          className={`flex items-center gap-1.5 text-ui-meta ${provider.keyStatus === 'invalid' ? 'text-destructive' : provider.keyStatus === 'valid' ? 'text-success' : 'text-muted-foreground'}`}
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
          <p className="text-ui-meta text-muted-foreground">
            Quota reported by provider when available
          </p>
        )}
        {provider.availableModels && provider.availableModels.length > 0 && (
          <details className="text-ui-meta text-muted-foreground">
            <summary className="cursor-pointer py-1">
              Models{' '}
              <span className="text-muted-foreground">{provider.availableModels.length}</span>
            </summary>
            <ShowMoreList
              items={provider.availableModels}
              groupKey={`provider-card:${provider.id}:models`}
              label="models"
              renderItem={(model) => (
                <li className="truncate text-muted-foreground" key={model.ref} title={model.name}>
                  {model.name}
                </li>
              )}
            />
          </details>
        )}
        {
          <p className="flex flex-wrap items-start gap-1.5 text-ui-meta text-muted-foreground">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            <DataUseBadge dataUse={provider.dataUse} />
            {provider.dataUse && <span>{provider.dataUse}</span>}
          </p>
        }
        <footer className="provider-card-footer mt-auto flex min-w-0 flex-nowrap items-center gap-2 pt-2">
          <span
            className="provider-card-capacity min-w-0 flex-1 truncate text-ui-meta text-muted-foreground"
            title={
              provider.stepsLeftToday === null
                ? 'Rate limited, no daily cap'
                : `\u2248 ${String(provider.stepsLeftToday)} steps today`
            }
          >
            {provider.stepsLeftToday === null ? (
              'No daily cap'
            ) : (
              <>
                {'\u2248 '}
                <CountUp to={provider.stepsLeftToday} /> steps today
              </>
            )}
          </span>
          <div className="provider-card-footer-actions flex shrink-0 items-center gap-1">
            <Button
              aria-label={`Test ${provider.name}`}
              disabled={probing || !provider.enabled}
              onClick={onTest}
              size="sm"
              variant="secondary"
            >
              {probing ? <LatticeLoader label="Testing" /> : null}
              {probing ? 'Testing\u2026' : 'Test'}
            </Button>
            <Button aria-label="Manage provider" onClick={onManageKey} size="sm" variant="ghost">
              Manage
            </Button>
          </div>
        </footer>
      </article>
    </div>
  );
}
