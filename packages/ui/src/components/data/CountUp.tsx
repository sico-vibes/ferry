// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';

export function CountUp({
  to,
  duration = 500,
  className,
}: {
  to: number;
  duration?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(to);
  const previous = useRef(to);
  useEffect(() => {
    const from = previous.current;
    previous.current = to;
    if (from === to) return;
    if (reduced) {
      setValue(to);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      setValue(Math.round(from + (to - from) * progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [duration, reduced, to]);
  return <span className={className}>{value.toLocaleString()}</span>;
}
