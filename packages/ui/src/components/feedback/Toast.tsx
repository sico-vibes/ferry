// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { motion, useReducedMotion } from 'motion/react';
import { Check, Info, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { IconButton } from '../primitives';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
const icons = { info: Info, success: Check, warning: TriangleAlert, error: X };
export function Toast({
  kind = 'info',
  children,
  onDismiss,
}: {
  kind?: ToastKind;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const reduced = useReducedMotion();
  const Icon = icons[kind];
  return (
    <motion.div
      animate={{ opacity: 1, x: 0 }}
      drag={reduced ? false : 'x'}
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > 80) onDismiss?.();
      }}
      initial={reduced ? false : { opacity: 0, x: 20 }}
      className="flex min-w-[280px] items-center gap-2 rounded-xl border border-border-hair bg-panel px-3 py-2.5 text-label shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
    >
      <Icon
        className={
          kind === 'success'
            ? 'text-success'
            : kind === 'warning'
              ? 'text-warn'
              : kind === 'error'
                ? 'text-danger'
                : 'text-link'
        }
        size={15}
      />
      <span className="flex-1 text-text-1">{children}</span>
      <IconButton label="Dismiss notification" size="sm" onClick={onDismiss}>
        <X size={14} />
      </IconButton>
    </motion.div>
  );
}
export function Toaster({
  messages,
}: {
  messages: { id: string; kind: ToastKind; text: string }[];
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  return (
    <div aria-label="Notifications" className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {messages
        .filter((message) => !dismissed.includes(message.id))
        .map((message) => (
          <Toast
            key={message.id}
            kind={message.kind}
            onDismiss={() => {
              setDismissed((ids) => [...ids, message.id]);
            }}
          >
            {message.text}
          </Toast>
        ))}
    </div>
  );
}
