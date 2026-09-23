import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';

export interface AmbientGlowProps {
  glows: { color: 'warm' | 'blue'; x: string; y: string; size: number }[];
  className?: string;
}

export function AmbientGlow({ glows, className }: AmbientGlowProps) {
  const style: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    backgroundImage: glows
      .map(
        ({ color, x, y, size }) =>
          `radial-gradient(circle ${size.toString()}px at ${x} ${y}, var(--glow-${color}), transparent)`,
      )
      .join(', '),
  };

  return <div aria-hidden="true" className={cn(className)} style={style} />;
}
