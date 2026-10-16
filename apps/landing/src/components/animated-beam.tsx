'use client';

/*
 * Adapted from Magic UI Animated Beam.
 * https://magicui.design/docs/components/animated-beam
 * Copyright (c) Magic UI, MIT License. See apps/landing/THIRD-PARTY.md.
 */

import { useEffect, useId, useState, type RefObject } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface AnimatedBeamProps {
  className?: string;
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  curvature?: number;
  reverse?: boolean;
  pathColor?: string;
  pathWidth?: number;
  pathOpacity?: number;
  gradientStartColor?: string;
  gradientStopColor?: string;
  delay?: number;
  duration?: number;
  repeat?: number;
  repeatDelay?: number;
  startXOffset?: number;
  startYOffset?: number;
  endXOffset?: number;
  endYOffset?: number;
}

export function AnimatedBeam({
  className,
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 5,
  delay = 0,
  pathColor = 'var(--beam-track)',
  pathWidth = 2,
  pathOpacity = 0.55,
  gradientStartColor = 'var(--beam-light)',
  gradientStopColor = 'var(--primary)',
  repeat = Infinity,
  repeatDelay = 0,
  startXOffset = 0,
  startYOffset = 0,
  endXOffset = 0,
  endYOffset = 0,
}: AnimatedBeamProps) {
  const id = useId();
  const reducedMotion = useReducedMotion();
  const [pathD, setPathD] = useState('');
  const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 });

  const gradientCoordinates = reverse
    ? {
        x1: ['90%', '-10%'],
        x2: ['100%', '0%'],
        y1: ['0%', '0%'],
        y2: ['0%', '0%'],
      }
    : {
        x1: ['10%', '110%'],
        x2: ['0%', '100%'],
        y1: ['0%', '0%'],
        y2: ['0%', '0%'],
      };

  useEffect(() => {
    const updatePath = () => {
      const container = containerRef.current;
      const from = fromRef.current;
      const to = toRef.current;
      if (!container || !from || !to) return;

      const containerRect = container.getBoundingClientRect();
      const rectA = from.getBoundingClientRect();
      const rectB = to.getBoundingClientRect();
      const svgWidth = containerRect.width;
      const svgHeight = containerRect.height;
      setSvgDimensions({ width: svgWidth, height: svgHeight });

      const startX = rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
      const startY = rectA.top - containerRect.top + rectA.height / 2 + startYOffset;
      const endX = rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
      const endY = rectB.top - containerRect.top + rectB.height / 2 + endYOffset;
      const controlY = startY - curvature;
      const controlX = (startX + endX) / 2;
      setPathD(
        `M ${String(startX)},${String(startY)} Q ${String(controlX)},${String(controlY)} ${String(endX)},${String(endY)}`,
      );
    };

    const resizeObserver = new ResizeObserver(() => {
      updatePath();
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    updatePath();
    window.addEventListener('resize', updatePath);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePath);
    };
  }, [containerRef, fromRef, toRef, curvature, startXOffset, startYOffset, endXOffset, endYOffset]);

  return (
    <svg
      fill="none"
      width={svgDimensions.width}
      height={svgDimensions.height}
      xmlns="http://www.w3.org/2000/svg"
      className={cn('pointer-events-none absolute top-0 left-0 transform-gpu stroke-2', className)}
      viewBox={`0 0 ${String(svgDimensions.width)} ${String(svgDimensions.height)}`}
      aria-hidden="true"
    >
      <path
        d={pathD}
        stroke={pathColor}
        strokeWidth={pathWidth}
        strokeOpacity={reducedMotion ? 0.9 : pathOpacity}
        strokeLinecap="round"
      />
      {reducedMotion ? null : (
        <path
          d={pathD}
          strokeWidth={pathWidth}
          stroke={`url(#${id})`}
          strokeOpacity="1"
          strokeLinecap="round"
        />
      )}
      {reducedMotion ? null : (
        <defs>
          <motion.linearGradient
            className="transform-gpu"
            id={id}
            gradientUnits="userSpaceOnUse"
            initial={{ x1: '0%', x2: '0%', y1: '0%', y2: '0%' }}
            animate={{
              x1: gradientCoordinates.x1,
              x2: gradientCoordinates.x2,
              y1: gradientCoordinates.y1,
              y2: gradientCoordinates.y2,
            }}
            transition={{
              delay,
              duration,
              ease: [0.16, 1, 0.3, 1],
              repeat,
              repeatDelay,
            }}
          >
            <stop stopColor={gradientStartColor} stopOpacity="0" />
            <stop stopColor={gradientStartColor} />
            <stop offset="32.5%" stopColor={gradientStopColor} />
            <stop offset="100%" stopColor={gradientStopColor} stopOpacity="0" />
          </motion.linearGradient>
        </defs>
      )}
    </svg>
  );
}
