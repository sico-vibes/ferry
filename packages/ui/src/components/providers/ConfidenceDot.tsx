import { cn } from '../../lib/cn';

const labels = { exact: 'Exact', estimated: 'Estimated', learned: 'Learned', unknown: 'Unknown' };
const colors = {
  exact: 'bg-success',
  estimated: 'bg-blue-500',
  learned: 'bg-[var(--brand-lilac)]',
  unknown: 'bg-text-3',
};

export function ConfidenceDot({
  confidence,
  className,
}: {
  confidence: keyof typeof labels;
  className?: string;
}) {
  return (
    <span
      aria-label={`${labels[confidence]} quota confidence`}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', colors[confidence], className)}
      role="img"
      title={`${labels[confidence]} quota data`}
    />
  );
}
