import type { Provider, ProviderKey } from '@ferry/shared';
import { UiV2 } from '@ferry/ui';

type ProviderStatusCode = Provider['health'] | Provider['keyStatus'] | ProviderKey['status'];

function badgeContent(
  status: ProviderStatusCode,
  cooldownUntil: string | null,
  enabled: boolean,
): { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' } {
  const cooldownMs = cooldownUntil ? Date.parse(cooldownUntil) - Date.now() : 0;
  const cooling =
    status === 'rate_limited' ||
    status === 'cooldown' ||
    (status === 'disabled' && enabled && cooldownMs > 0);
  if (cooling) {
    if (!cooldownUntil) return { label: 'Cooling down', variant: 'warning' };
    if (cooldownMs <= 0) return { label: 'Healthy', variant: 'success' };
    const minutes = Math.ceil(cooldownMs / 60_000);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    const duration = hours
      ? `${String(hours)}h${remainingMinutes ? ` ${String(remainingMinutes)}m` : ''}`
      : `${String(minutes)}m`;
    return { label: `Cooling down ${duration}`, variant: 'warning' };
  }
  if (status === 'ok' || status === 'valid') return { label: 'Healthy', variant: 'success' };
  if (status === 'invalid' || status === 'auth_invalid')
    return { label: 'Invalid', variant: 'destructive' };
  if (status === 'disabled' || status === 'account_disabled')
    return { label: 'Disabled', variant: 'secondary' };
  if (status === 'missing') return { label: 'Missing', variant: 'outline' };
  if (status === 'unchecked') return { label: 'Not checked', variant: 'outline' };
  if (status === 'not_applicable') return { label: 'Not required', variant: 'secondary' };
  if (status === 'down') return { label: 'Unavailable', variant: 'destructive' };
  return { label: 'Unknown', variant: 'secondary' };
}

export function ProviderStatusBadge({
  status,
  cooldownUntil = null,
  enabled = true,
}: {
  status: ProviderStatusCode;
  cooldownUntil?: string | null;
  enabled?: boolean;
}) {
  const { label, variant } = badgeContent(status, cooldownUntil, enabled);
  return <UiV2.Badge variant={variant}>{label}</UiV2.Badge>;
}
