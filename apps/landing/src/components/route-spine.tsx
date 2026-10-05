'use client';

import { useEffect, useState, type RefObject } from 'react';
import { cn } from '@/lib/utils';

interface RouteSpineProps {
  containerRef: RefObject<HTMLElement | null>;
  cardRefs: readonly RefObject<HTMLElement | null>[];
  ferryRef: RefObject<HTMLElement | null>;
  gatewayRef: RefObject<HTMLElement | null>;
  className?: string;
}

interface SpineGeometry {
  width: number;
  height: number;
  elbows: string[];
  spine: string;
  intoFerry: string;
  intoGateway: string;
  joinX: number;
  joinY: number;
}

const RADIUS = 12;

const fmt = (value: number): string => value.toFixed(1);

function edgePoint(
  container: DOMRect,
  element: DOMRect,
  side: 'left' | 'right',
): { x: number; y: number } {
  return {
    x: (side === 'right' ? element.right : element.left) - container.left,
    y: element.top - container.top + element.height / 2,
  };
}

function elbow(startX: number, startY: number, spineX: number, targetY: number): string {
  const rise = targetY - startY;
  if (Math.abs(rise) < 1) return `M ${fmt(startX)} ${fmt(startY)} H ${fmt(spineX)}`;
  const direction = rise > 0 ? 1 : -1;
  const radius = Math.min(RADIUS, Math.abs(spineX - startX) / 2, Math.abs(rise) / 2);
  const turnY = startY + direction * radius;
  return `M ${fmt(startX)} ${fmt(startY)} H ${fmt(spineX - radius)} Q ${fmt(spineX)} ${fmt(startY)} ${fmt(spineX)} ${fmt(turnY)}`;
}

function measure(
  container: HTMLElement,
  cardRefs: readonly RefObject<HTMLElement | null>[],
  ferry: HTMLElement,
  gateway: HTMLElement,
): SpineGeometry | null {
  const containerRect = container.getBoundingClientRect();
  const ferryRect = ferry.getBoundingClientRect();
  const gatewayRect = gateway.getBoundingClientRect();
  const cards = cardRefs.flatMap((ref) => {
    const node = ref.current;
    return node ? [node.getBoundingClientRect()] : [];
  });
  if (cards.length === 0 || containerRect.width === 0) return null;

  const starts = cards.map((rect) => edgePoint(containerRect, rect, 'right'));
  const ferryPoint = edgePoint(containerRect, ferryRect, 'left');
  const ferryRight = edgePoint(containerRect, ferryRect, 'right');
  const gatewayPoint = edgePoint(containerRect, gatewayRect, 'left');
  const firstStart = starts[0];
  if (!firstStart || ferryPoint.x <= firstStart.x) return null;

  const cardEdge = Math.max(...starts.map((point) => point.x));
  const gap = ferryPoint.x - cardEdge;
  const spineX = cardEdge + Math.min(36, gap * 0.42);
  const top = Math.min(...starts.map((point) => point.y));
  const bottom = Math.max(...starts.map((point) => point.y));
  const elbows = starts.map((point) => elbow(point.x, point.y, spineX, ferryPoint.y));
  const spine = bottom - top > 1 ? `M ${fmt(spineX)} ${fmt(top)} V ${fmt(bottom)}` : '';
  const intoFerry = `M ${fmt(spineX)} ${fmt(ferryPoint.y)} H ${fmt(ferryPoint.x)}`;
  const intoGateway =
    gatewayPoint.x > ferryRight.x
      ? `M ${fmt(ferryRight.x)} ${fmt(ferryRight.y)} H ${fmt(gatewayPoint.x)}`
      : '';

  return {
    width: containerRect.width,
    height: containerRect.height,
    elbows,
    spine,
    intoFerry,
    intoGateway,
    joinX: ferryPoint.x,
    joinY: ferryPoint.y,
  };
}

export function RouteSpine({
  containerRef,
  cardRefs,
  ferryRef,
  gatewayRef,
  className,
}: RouteSpineProps) {
  const [geometry, setGeometry] = useState<SpineGeometry | null>(null);

  useEffect(() => {
    const update = () => {
      const container = containerRef.current;
      const ferry = ferryRef.current;
      const gateway = gatewayRef.current;
      if (!container || !ferry || !gateway) {
        setGeometry(null);
        return;
      }
      setGeometry(measure(container, cardRefs, ferry, gateway));
    };

    const observer = new ResizeObserver(() => {
      update();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    for (const ref of cardRefs) {
      if (ref.current) observer.observe(ref.current);
    }
    if (ferryRef.current) observer.observe(ferryRef.current);
    if (gatewayRef.current) observer.observe(gatewayRef.current);
    update();
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [cardRefs, containerRef, ferryRef, gatewayRef]);

  if (!geometry) return null;

  return (
    <svg
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 hidden md:block', className)}
      fill="none"
      viewBox={`0 0 ${fmt(geometry.width)} ${fmt(geometry.height)}`}
      width={geometry.width}
      height={geometry.height}
    >
      {geometry.elbows.map((path) => (
        <path
          key={path}
          d={path}
          stroke="var(--beam-track)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      ))}
      {geometry.spine ? (
        <path d={geometry.spine} stroke="var(--beam-track)" strokeLinecap="round" strokeWidth="2" />
      ) : null}
      <path d={geometry.intoFerry} stroke="var(--beam)" strokeLinecap="round" strokeWidth="2" />
      {geometry.intoGateway ? (
        <path d={geometry.intoGateway} stroke="var(--beam)" strokeLinecap="round" strokeWidth="2" />
      ) : null}
      <circle cx={fmt(geometry.joinX)} cy={fmt(geometry.joinY)} fill="var(--primary)" r="3.5" />
    </svg>
  );
}
