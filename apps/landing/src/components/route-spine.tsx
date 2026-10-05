'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useState, type RefObject } from 'react';
import { cn } from '@/lib/utils';

interface RouteSpineProps {
  containerRef: RefObject<HTMLElement | null>;
  cardRefs: readonly RefObject<HTMLElement | null>[];
  ferryRef: RefObject<HTMLElement | null>;
  gatewayRef: RefObject<HTMLElement | null>;
  present?: boolean;
  className?: string;
}

interface SpineGeometry {
  width: number;
  height: number;
  tracks: string[];
  flows: string[];
  joinX: number;
  joinY: number;
}

/** Straight lead out of a card, then a modest quarter-circle onto the spine. */
const LEAD = 14;
const RADIUS = 18;
const KAPPA = 0.5522847498;

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

function turnRadius(
  startX: number,
  startY: number,
  spineX: number,
  endX: number,
  endY: number,
): number {
  return Math.min(
    RADIUS,
    Math.abs(endY - startY) / 2,
    Math.max(0, spineX - startX) * 0.72,
    Math.max(0, endX - spineX) * 0.72,
  );
}

/** Card edge → smooth corner → spine. Stops where it becomes vertical. */
function elbow(startX: number, startY: number, spineX: number, endX: number, endY: number): string {
  const rise = endY - startY;
  if (Math.abs(rise) < 2 || spineX <= startX) {
    return `M ${fmt(startX)} ${fmt(startY)} H ${fmt(spineX)}`;
  }
  const direction = rise > 0 ? 1 : -1;
  const radius = turnRadius(startX, startY, spineX, endX, endY);
  const handle = radius * KAPPA;
  const entryY = startY + direction * radius;
  return [
    `M ${fmt(startX)} ${fmt(startY)}`,
    `H ${fmt(spineX - radius)}`,
    `C ${fmt(spineX - radius + handle)} ${fmt(startY)}, ${fmt(spineX)} ${fmt(startY + direction * handle)}, ${fmt(spineX)} ${fmt(entryY)}`,
  ].join(' ');
}

/** Full card → Ferry path, including the turn off the spine toward Ferry. */
function flowPath(
  startX: number,
  startY: number,
  spineX: number,
  endX: number,
  endY: number,
): string {
  const rise = endY - startY;
  if (Math.abs(rise) < 2) return `M ${fmt(startX)} ${fmt(startY)} H ${fmt(endX)}`;
  const direction = rise > 0 ? 1 : -1;
  const radius = turnRadius(startX, startY, spineX, endX, endY);
  const handle = radius * KAPPA;
  const entryY = startY + direction * radius;
  const exitY = endY - direction * radius;
  const parts = [
    `M ${fmt(startX)} ${fmt(startY)}`,
    `H ${fmt(spineX - radius)}`,
    `C ${fmt(spineX - radius + handle)} ${fmt(startY)}, ${fmt(spineX)} ${fmt(startY + direction * handle)}, ${fmt(spineX)} ${fmt(entryY)}`,
  ];
  if (Math.abs(exitY - entryY) > 0.5) parts.push(`V ${fmt(exitY)}`);
  parts.push(
    `C ${fmt(spineX)} ${fmt(exitY + direction * handle)}, ${fmt(spineX + handle)} ${fmt(endY)}, ${fmt(spineX + radius)} ${fmt(endY)}`,
    `H ${fmt(endX)}`,
  );
  return parts.join(' ');
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
  const spineX = cardEdge + LEAD + RADIUS;
  if (spineX >= ferryPoint.x) return null;

  const flows = starts.map((point) =>
    flowPath(point.x, point.y, spineX, ferryPoint.x, ferryPoint.y),
  );
  const joinRadius = Math.min(RADIUS, Math.max(0, ferryPoint.x - spineX) * 0.72);
  const entryYs = starts.map((point) => {
    const rise = ferryPoint.y - point.y;
    if (Math.abs(rise) < 2) return point.y;
    const direction = rise > 0 ? 1 : -1;
    const radius = turnRadius(point.x, point.y, spineX, ferryPoint.x, ferryPoint.y);
    return point.y + direction * radius;
  });
  const above = entryYs.filter((y) => y < ferryPoint.y - 1);
  const below = entryYs.filter((y) => y > ferryPoint.y + 1);
  const tracks = starts.map((point) => elbow(point.x, point.y, spineX, ferryPoint.x, ferryPoint.y));
  const upperEnd = Math.min(...above, ferryPoint.y);
  const lowerEnd = Math.max(...below, ferryPoint.y);
  if (above.length > 0 && ferryPoint.y - joinRadius - upperEnd > 0.5) {
    tracks.push(`M ${fmt(spineX)} ${fmt(upperEnd)} V ${fmt(ferryPoint.y - joinRadius)}`);
  }
  if (below.length > 0 && lowerEnd - (ferryPoint.y + joinRadius) > 0.5) {
    tracks.push(`M ${fmt(spineX)} ${fmt(ferryPoint.y + joinRadius)} V ${fmt(lowerEnd)}`);
  }
  const handle = joinRadius * KAPPA;
  if (above.length > 0) {
    const fromY = ferryPoint.y - joinRadius;
    tracks.push(
      `M ${fmt(spineX)} ${fmt(fromY)} C ${fmt(spineX)} ${fmt(fromY + handle)}, ${fmt(spineX + handle)} ${fmt(ferryPoint.y)}, ${fmt(spineX + joinRadius)} ${fmt(ferryPoint.y)}`,
    );
  }
  if (below.length > 0) {
    const fromY = ferryPoint.y + joinRadius;
    tracks.push(
      `M ${fmt(spineX)} ${fmt(fromY)} C ${fmt(spineX)} ${fmt(fromY - handle)}, ${fmt(spineX + handle)} ${fmt(ferryPoint.y)}, ${fmt(spineX + joinRadius)} ${fmt(ferryPoint.y)}`,
    );
  }
  tracks.push(`M ${fmt(spineX + joinRadius)} ${fmt(ferryPoint.y)} H ${fmt(ferryPoint.x)}`);
  const intoGateway =
    gatewayPoint.x > ferryRight.x
      ? `M ${fmt(ferryRight.x)} ${fmt(ferryRight.y)} H ${fmt(gatewayPoint.x)}`
      : '';
  if (intoGateway) tracks.push(intoGateway);

  return {
    width: containerRect.width,
    height: containerRect.height,
    tracks,
    flows: intoGateway ? [...flows, intoGateway] : flows,
    joinX: ferryPoint.x,
    joinY: ferryPoint.y,
  };
}

export function RouteSpine({
  containerRef,
  cardRefs,
  ferryRef,
  gatewayRef,
  present = false,
  className,
}: RouteSpineProps) {
  const reduced = useReducedMotion();
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
      className={cn(
        'pointer-events-none absolute inset-0 hidden md:block',
        present && reduced === false && 'route-spine-present',
        className,
      )}
      fill="none"
      viewBox={`0 0 ${fmt(geometry.width)} ${fmt(geometry.height)}`}
      width={geometry.width}
      height={geometry.height}
    >
      {geometry.tracks.map((path, index) => (
        <path
          key={`track-${String(index)}`}
          className="route-track"
          d={path}
          stroke="var(--beam-track)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      ))}
      {reduced === false
        ? geometry.flows.map((path, index) => (
            <path
              key={`flow-${String(index)}`}
              className="route-flow"
              d={path}
              stroke="var(--beam-light)"
              strokeLinecap="round"
              strokeWidth="2"
              style={{ animationDelay: `${String(index * 0.65)}s` }}
            />
          ))
        : null}
      <circle cx={fmt(geometry.joinX)} cy={fmt(geometry.joinY)} fill="var(--primary)" r="3" />
    </svg>
  );
}
