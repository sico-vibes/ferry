import { motion, useReducedMotion } from 'motion/react';
import { useId } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/cn';
import { CountUp } from './CountUp';

export interface RingGaugeProps {
  value: number;
  size?: number;
  stroke?: number;
  label?: string;
}
export function RingGauge({ value, size = 40, stroke = 4, label }: RingGaugeProps) {
  const filterId = `ring-gauge-glow-${useId().replaceAll(':', '')}`;
  const normalized = Math.max(0, Math.min(100, value));
  const radius = (size - stroke) / 2;
  const circumference = Math.PI * radius * 2;
  const reducedMotion = useReducedMotion();
  const ariaLabel = label ?? `${String(normalized)}% of today's free capacity remaining`;
  return (
    <svg
      aria-label={ariaLabel}
      className="shrink-0 overflow-visible"
      height={size}
      role="img"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      width={size}
    >
      <defs>
        <filter height="180%" id={filterId} width="180%" x="-40%" y="-40%">
          <feGaussianBlur result="blur" stdDeviation="2" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        stroke="var(--ring-track)"
        strokeWidth={stroke}
      />
      <motion.circle
        animate={{ strokeDashoffset: circumference * (1 - normalized / 100) }}
        cx={size / 2}
        cy={size / 2}
        fill="none"
        initial={false}
        r={radius}
        stroke="var(--blue-500)"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - normalized / 100)}
        strokeLinecap="round"
        strokeWidth={stroke}
        style={{ rotate: -90, transformOrigin: '50% 50%', filter: `url(#${filterId})` }}
        transition={reducedMotion ? { duration: 0 } : { duration: 0.22, ease: 'easeOut' }}
      />
      <text
        className="fill-text-1 font-sans text-[10px] font-semibold tabular-nums"
        dominantBaseline="central"
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {normalized}%
      </text>
    </svg>
  );
}

export interface CapacityCardProps {
  stepsLeft: number;
  percent: number;
  onAddProvider?: () => void;
  onOpenBreakdown?: () => void;
  className?: string;
}
export function CapacityCard({
  stepsLeft,
  percent,
  onAddProvider,
  onOpenBreakdown,
  className,
}: CapacityCardProps) {
  return (
    <div
      className={cn(
        'relative flex h-16 w-full items-center justify-between rounded-card border border-blue-500/30 bg-[image:var(--bg-capacity)] px-3 text-left shadow-[inset_0_1px_0_var(--highlight-top)] transition hover:border-blue-500/50 hover:brightness-110',
        className,
      )}
    >
      <button
        aria-label={`${String(stepsLeft)} steps left today, ${String(percent)}% capacity remaining. Open capacity breakdown`}
        className="absolute inset-0 z-0 rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app"
        onClick={onOpenBreakdown}
        type="button"
      />
      <span className="pointer-events-none relative z-10 flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-body font-semibold text-text-1">
          ≈ <CountUp to={stepsLeft} /> steps left today
        </span>
        <button
          className="pointer-events-auto inline-flex w-fit items-center gap-1 text-meta font-medium text-link hover:brightness-125 focus-visible:outline-none focus-visible:underline"
          onClick={onAddProvider}
          type="button"
        >
          Add provider
          <ArrowUpRight aria-hidden="true" size={14} />
        </button>
      </span>
      <span className="pointer-events-none relative z-10">
        <RingGauge value={percent} />
      </span>
    </div>
  );
}

export { AnimatedList } from './AnimatedList';
export { CountUp } from './CountUp';
