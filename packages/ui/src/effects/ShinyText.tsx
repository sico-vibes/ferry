// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function ShinyText({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <span
      className={cn(
        'inline-block text-text-2',
        !reduced && 'animate-[ferry-text-shine_4s_linear_infinite]',
        className,
      )}
    >
      {children}
    </span>
  );
}
