'use client';

import { useReducedMotion } from 'motion/react';
import Image from 'next/image';
import { useRef, useState, type PointerEvent } from 'react';
import { Reveal } from '@/components/reveal';
import { SectionHeading, Shell } from '@/components/shell';
import { dock } from '@/lib/site';

export function ProductShots() {
  const frameRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (reduced === true) return;
    const node = frameRef.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    const px = (event.clientX - bounds.left) / bounds.width - 0.5;
    const py = (event.clientY - bounds.top) / bounds.height - 0.5;
    setTilt({ x: py * -3.5, y: px * 4 });
  };

  const transform =
    reduced === true ? undefined : `rotateX(${String(tilt.x)}deg) rotateY(${String(tilt.y)}deg)`;

  return (
    <section id="dock" className="scroll-mt-14 py-16">
      <Shell>
        <Reveal>
          <SectionHeading title={dock.title}>{dock.lead}</SectionHeading>
          <figure className="mx-auto mt-12 max-w-5xl [perspective:1200px]">
            <div
              ref={frameRef}
              onPointerMove={onMove}
              onPointerLeave={() => {
                setTilt({ x: 0, y: 0 });
              }}
              className="dock-frame overflow-hidden rounded-card border border-border bg-card"
              style={transform ? { transform } : undefined}
            >
              <Image
                src="/screenshots/routing.png"
                alt={dock.routingAlt}
                width={1440}
                height={900}
                sizes="(min-width: 1024px) 960px, 100vw"
                className="h-auto w-full"
                style={
                  reduced === true
                    ? undefined
                    : {
                        transform: `translate3d(${String(-tilt.y * 1.4)}px, ${String(tilt.x * 1.4)}px, 0)`,
                      }
                }
              />
            </div>
            <figcaption className="mt-3 text-center text-sm text-muted-foreground">
              {dock.routingCaption}
            </figcaption>
          </figure>
        </Reveal>
      </Shell>
    </section>
  );
}
