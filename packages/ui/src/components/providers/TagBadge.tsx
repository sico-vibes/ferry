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
  legit: 'bg-success/10 text-success',
  promo: 'bg-warning/10 text-warning',
  trial: 'bg-warning/10 text-warning',
  credits: 'bg-accent text-accent-foreground',
  paid: 'bg-accent text-accent-foreground',
  cli: 'bg-muted text-muted-foreground',
  caution: 'bg-warning/10 text-warning',
  subscription_oauth: 'bg-warning/10 text-warning',
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
        'inline-flex h-5 items-center rounded-full px-2 text-ui-meta font-medium',
        styles[kind],
        className,
      )}
      title={description}
    >
      {labels[kind]}
    </span>
  );
}
