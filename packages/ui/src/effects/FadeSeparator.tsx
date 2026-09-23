import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export interface FadeSeparatorProps {
  tone?: 'neutral' | 'blue';
  className?: string;
}

export function FadeSeparator({ tone = 'neutral', className }: FadeSeparatorProps) {
  const style: CSSProperties = {
    height: '1px',
    marginBlock: '16px',
    background:
      tone === 'blue'
        ? 'linear-gradient(90deg, transparent, var(--blue-500), transparent)'
        : 'var(--fade-line)',
    ...(tone === 'blue' ? { boxShadow: '0 0 12px 1px var(--blue-glow)' } : {}),
  };

  return <div aria-hidden="true" className={cn('w-full', className)} style={style} />;
}
