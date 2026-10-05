'use client';

import { useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Spotlight({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const node = ref.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    node.style.setProperty('--spot-x', `${String(event.clientX - bounds.left)}px`);
    node.style.setProperty('--spot-y', `${String(event.clientY - bounds.top)}px`);
  };

  return (
    <div ref={ref} className={cn('spotlight', className)} onPointerMove={onMove}>
      {children}
    </div>
  );
}
