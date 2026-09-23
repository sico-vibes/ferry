import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface GradientTextProps {
  gradient?: 'headline' | 'signature';
  className?: string;
  children: ReactNode;
}

export function GradientText({ gradient = 'headline', className, children }: GradientTextProps) {
  return (
    <span
      className={cn('bg-clip-text text-transparent', className)}
      style={{ backgroundImage: `var(--grad-${gradient})` }}
    >
      {children}
    </span>
  );
}
