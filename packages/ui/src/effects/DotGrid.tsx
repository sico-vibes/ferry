import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export interface DotGridProps {
  radius?: number;
  centerX?: string;
  centerY?: string;
  className?: string;
}

export function DotGrid({
  radius = 420,
  centerX = '50%',
  centerY = '50%',
  className,
}: DotGridProps) {
  const style: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    backgroundImage: 'radial-gradient(var(--dot-color) 1px, transparent 1px)',
    backgroundSize: '14px 14px',
    maskImage: `radial-gradient(circle ${radius.toString()}px at ${centerX} ${centerY}, var(--text-1), transparent)`,
    WebkitMaskImage: `radial-gradient(circle ${radius.toString()}px at ${centerX} ${centerY}, var(--text-1), transparent)`,
  };

  return <div aria-hidden="true" className={cn(className)} style={style} />;
}
