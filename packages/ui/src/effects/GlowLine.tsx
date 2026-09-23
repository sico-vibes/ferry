import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export interface GlowLineProps {
  orientation: 'horizontal' | 'vertical';
  from?: string;
  to?: string;
  className?: string;
}

export function GlowLine({ orientation, from = '0%', to = '100%', className }: GlowLineProps) {
  const isVertical = orientation === 'vertical';
  const style: CSSProperties = {
    position: 'absolute',
    background: isVertical
      ? 'linear-gradient(180deg, transparent, var(--blue-500), transparent)'
      : 'linear-gradient(90deg, transparent, var(--blue-500), transparent)',
    boxShadow: '0 0 12px 1px var(--blue-glow)',
    ...(isVertical
      ? { width: '1px', top: from, bottom: `calc(100% - ${to})` }
      : { height: '1px', left: from, right: `calc(100% - ${to})` }),
  };

  return <span aria-hidden="true" className={cn('pointer-events-none', className)} style={style} />;
}
