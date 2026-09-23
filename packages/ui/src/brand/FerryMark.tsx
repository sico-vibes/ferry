import type { CSSProperties } from 'react';
import iconUrl from '../assets/brand/ferry-icon.png';
import markUrl from '../assets/brand/ferry-mark.png';
import { cn } from '../lib/cn';

/**
 * Ferry logo (DESIGN.md §2.9).
 * - `icon`: the colored app icon image (rail logo).
 * - `brand`: the mark filled with the lilac→violet brand gradient (hero tile).
 * - `mono`: the mark filled with `currentColor` (model picker glyph, model badges).
 */
export type FerryMarkVariant = 'icon' | 'brand' | 'mono';

export interface FerryMarkProps {
  variant?: FerryMarkVariant;
  size?: number;
  className?: string;
  label?: string;
  decorative?: boolean;
}

export function FerryMark({
  variant = 'icon',
  size = 24,
  className,
  label = 'Ferry',
  decorative = false,
}: FerryMarkProps) {
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': label } as const);

  if (variant === 'icon') {
    return (
      <img
        alt={decorative ? '' : label}
        aria-hidden={decorative || undefined}
        className={cn('shrink-0 select-none', className)}
        draggable={false}
        height={size}
        src={iconUrl}
        width={size}
      />
    );
  }

  const mask = `url(${markUrl})`;
  const style: CSSProperties = {
    width: size,
    height: size,
    background: variant === 'brand' ? 'var(--grad-brand)' : 'currentColor',
    maskImage: mask,
    WebkitMaskImage: mask,
    maskSize: 'contain',
    WebkitMaskSize: 'contain',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
  };

  return <span {...a11y} className={cn('inline-block shrink-0', className)} style={style} />;
}
