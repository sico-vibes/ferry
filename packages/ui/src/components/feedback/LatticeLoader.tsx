// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { useReducedMotion } from 'motion/react';

export function LatticeLoader({ label = 'Loading' }: { label?: string }) {
  const reduced = useReducedMotion();
  return (
    <span
      aria-label={label}
      className="inline-flex items-center gap-2 text-label text-text-2"
      role="status"
    >
      <span
        aria-hidden="true"
        className={`grid grid-cols-3 gap-0.5 ${reduced ? '' : 'animate-pulse'}`}
      >
        {Array.from({ length: 9 }, (_, i) => (
          <i className="size-1.5 rounded-[1px] bg-blue-500/70" key={i} />
        ))}
      </span>
      {label}
    </span>
  );
}
