// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { motion, useReducedMotion } from 'motion/react';
import { Ban, Check, Circle, LoaderCircle, X } from 'lucide-react';

export type StatusMarkState = 'pending' | 'running' | 'succeeded' | 'failed' | 'denied';
const icons = { pending: Circle, running: LoaderCircle, succeeded: Check, failed: X, denied: Ban };
export function AdaptedStatusMark({ status, label }: { status: StatusMarkState; label?: string }) {
  const reduced = useReducedMotion();
  const Icon = icons[status];
  const color =
    status === 'succeeded'
      ? 'text-success'
      : status === 'failed' || status === 'denied'
        ? 'text-danger'
        : 'text-text-3';
  return (
    <motion.span
      aria-label={label ?? status}
      className={`inline-flex ${color}`}
      initial={reduced ? false : { scale: 0.88, opacity: 0.65 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: reduced ? 0 : 0.16 }}
      role="img"
    >
      <Icon className={status === 'running' && !reduced ? 'size-4 animate-spin' : 'size-4'} />
    </motion.span>
  );
}
