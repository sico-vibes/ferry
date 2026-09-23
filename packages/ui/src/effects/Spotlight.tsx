// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { useState, type PointerEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Spotlight({ children, className }: { children: ReactNode; className?: string }) {
  const [position, setPosition] = useState({ x: 50, y: 50 });
  function move(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    });
  }
  return (
    <div
      className={cn('relative', className)}
      onPointerMove={move}
      style={{
        backgroundImage: `radial-gradient(circle at ${String(position.x)}% ${String(position.y)}%, var(--spotlight), transparent 55%)`,
      }}
    >
      {children}
    </div>
  );
}
