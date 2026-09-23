import { cn } from '../../lib/cn';

export type TagBadgeKind = 'legit' | 'promo' | 'paid' | 'cli' | 'caution';

const labels: Record<TagBadgeKind, string> = {
  legit: 'Legit',
  promo: 'Promo',
  paid: 'Paid',
  cli: 'CLI',
  caution: 'Caution',
};

const styles: Record<TagBadgeKind, string> = {
  legit: 'bg-[var(--tint-success)] text-success',
  promo: 'bg-[var(--tint-warn)] text-warn',
  paid: 'bg-[var(--tint-blue)] text-link',
  cli: 'bg-white/[0.06] text-text-2',
  caution: 'bg-[var(--tint-danger)] text-danger',
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
