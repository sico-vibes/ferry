import type { ReactNode } from 'react';

export type LayoutSpace = 2 | 3 | 4 | 6 | 8;

export interface LayoutProps {
  children: ReactNode;
  gap?: LayoutSpace;
  className?: string;
}

export function Stack({ children, gap = 4, className = '' }: LayoutProps) {
  return (
    <div className={`ferry-stack ferry-gap-${String(gap)} ${className}`.trim()}>{children}</div>
  );
}
