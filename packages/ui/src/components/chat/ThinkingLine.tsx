// Adapted from React Bits (reactbits.dev) — MIT + Commons Clause
import { Check, Circle, LoaderCircle } from 'lucide-react';
import { ShinyText } from '../../effects/ShinyText';

export interface ThinkingStep {
  label: string;
  status: 'pending' | 'active' | 'done';
}
export function ReactBitsThinkingLine({
  steps,
  startedAt = Date.now(),
  running = false,
}: {
  steps: ThinkingStep[];
  startedAt?: number;
  running?: boolean;
}) {
  const seconds = Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1);
  return (
    <div className="text-label text-text-3">
      <span>
        {running ? <ShinyText>Thinking…</ShinyText> : 'Thought'} · {seconds}s
      </span>
      {steps.length > 0 && (
        <ul className="mt-2 space-y-1">
          {steps.map((step) => {
            const Icon =
              step.status === 'done' ? Check : step.status === 'active' ? LoaderCircle : Circle;
            return (
              <li className="flex items-center gap-1.5" key={step.label}>
                <Icon
                  className={`size-3 ${step.status === 'active' ? 'animate-spin motion-reduce:animate-none' : ''}`}
                />
                {step.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
