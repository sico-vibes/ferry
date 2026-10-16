import { BadgeCheck, Clock3, FlaskConical } from 'lucide-react';
import { UiV2 } from '@ferry/ui';

export function ProviderIntegrationStatus({
  state,
}: {
  state: 'Verified' | 'Beta' | 'Coming soon';
}) {
  const Icon = state === 'Verified' ? BadgeCheck : state === 'Beta' ? FlaskConical : Clock3;
  const label =
    state === 'Verified'
      ? 'Verified integration. Your account’s generation access is checked separately.'
      : state === 'Beta'
        ? 'Beta integration. Check your connection before using it.'
        : 'Integration coming soon.';
  return (
    <UiV2.Tooltip>
      <UiV2.TooltipTrigger asChild>
        <span className="provider-integration-icon" role="img" aria-label={label} tabIndex={0}>
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
      </UiV2.TooltipTrigger>
      <UiV2.TooltipContent>{label}</UiV2.TooltipContent>
    </UiV2.Tooltip>
  );
}
