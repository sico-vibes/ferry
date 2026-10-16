import { cn } from '@/lib/utils';

export function FerryMark({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('ferry-mark', className)} />;
}
