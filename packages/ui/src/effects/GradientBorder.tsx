import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface GradientBorderProps {
  gradient: 'signature' | 'composer' | 'send' | 'avatar';
  width?: number;
  radius: 'panel' | 'card' | 'input' | 'pill' | number;
  shimmer?: boolean;
  className?: string;
  innerClassName?: string;
  topBand?: { height: number; content: ReactNode };
  children: ReactNode;
}

const radiusTokens = {
  panel: '--r-panel',
  card: '--r-card',
  input: '--r-input',
  pill: '--r-pill',
} as const;

export function GradientBorder({
  gradient,
  width = 1.5,
  radius,
  shimmer = false,
  className,
  innerClassName,
  topBand,
  children,
}: GradientBorderProps) {
  const radiusValue =
    typeof radius === 'number' ? `${radius.toString()}px` : `var(${radiusTokens[radius]})`;
  const innerRadius =
    typeof radius === 'number'
      ? `${Math.max(radius - width, 0).toString()}px`
      : `calc(var(${radiusTokens[radius]}) - ${width.toString()}px)`;
  const outerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: radiusValue,
    background: `var(--grad-${gradient})`,
    backgroundSize: shimmer ? '200% 100%' : undefined,
    animation: shimmer ? 'ferry-shimmer 6s linear infinite' : undefined,
  };
  const innerStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    marginInline: `${width.toString()}px`,
    marginBottom: `${width.toString()}px`,
    borderRadius: innerRadius,
  };

  return (
    <div
      className={cn('motion-reduce:animate-none', className)}
      data-gradient={gradient}
      style={outerStyle}
    >
      {topBand ? (
        <div className="shrink-0" style={{ height: topBand.height }}>
          {topBand.content}
        </div>
      ) : null}
      <div className={cn('min-h-0', innerClassName)} style={innerStyle}>
        {children}
      </div>
    </div>
  );
}
