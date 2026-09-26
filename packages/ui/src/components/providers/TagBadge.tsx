import { cn } from '../../lib/cn';

export type TagBadgeKind = 'legit' | 'promo' | 'credits' | 'paid' | 'cli' | 'caution';

const labels: Record<TagBadgeKind, string> = {
  legit: 'Free',
  promo: 'Promo',
  credits: 'Credits',
  paid: 'Paid',
  cli: 'CLI',
  caution: 'Caution',
};

const styles: Record<TagBadgeKind, string> = {
  legit: 'bg-[var(--tint-success)] text-success',
  promo: 'bg-[var(--tint-warn)] text-warn',
  credits: 'bg-[var(--tint-blue)] text-link',
  paid: 'bg-[var(--tint-blue)] text-link',
  cli: 'bg-icon-circle text-text-2',
  caution: 'bg-[var(--tint-warn)] text-warn',
};

export function TagBadge({ kind, className }: { kind: TagBadgeKind; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-pill px-2 text-[11px] font-medium',
        styles[kind],
        className,
      )}
    >
      {labels[kind]}
    </span>
  );
}
