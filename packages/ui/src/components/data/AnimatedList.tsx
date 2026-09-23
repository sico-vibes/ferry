// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

export function AnimatedList({
  children,
  className,
}: {
  children: ReactNode[];
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <div className={className}>
      {children.map((child, index) => (
        <motion.div
          key={index}
          initial={reduced ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduced ? 0 : 0.18, delay: reduced ? 0 : index * 0.035 }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  );
}
