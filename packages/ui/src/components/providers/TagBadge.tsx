import { cn } from '../../lib/cn';

export type TagBadgeKind =
  'legit' | 'promo' | 'trial' | 'credits' | 'paid' | 'cli' | 'caution' | 'subscription_oauth';

const labels: Record<TagBadgeKind, string> = {
  legit: 'Free',
  promo: 'Promo',
  trial: 'Trial',
  credits: 'Credits',
  paid: 'Paid',
  cli: 'CLI',
  caution: 'Caution',
  subscription_oauth: 'Unofficial OAuth',
};

const styles: Record<TagBadgeKind, string> = {
  legit: 'bg-[var(--tint-success)] text-success',
  promo: 'bg-[var(--tint-warn)] text-warn',
  trial: 'bg-[var(--tint-warn)] text-warn',
  credits: 'bg-[var(--tint-blue)] text-link',
  paid: 'bg-[var(--tint-blue)] text-link',
  cli: 'bg-icon-circle text-text-2',
  caution: 'bg-[var(--tint-warn)] text-warn',
  subscription_oauth: 'bg-[var(--tint-warn)] text-warn',
};

export function TagBadge({ kind, className }: { kind: TagBadgeKind; className?: string }) {
  const description =
    kind === 'promo'
      ? 'Promotional — may end without notice'
      : kind === 'trial'
        ? 'Trial access is temporary and may require payment details'
        : labels[kind];
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-pill px-2 text-[11px] font-medium',
        styles[kind],
        className,
      )}
      title={description}
    >
      {labels[kind]}
    </span>
  );
}
