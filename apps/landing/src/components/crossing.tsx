'use client';

import { KeyRound } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { FerryMark } from '@/components/ferry-mark';
import { RouteSpine } from '@/components/route-spine';
import { SectionHeading, Shell } from '@/components/shell';
import { crossing } from '@/lib/site';
import { providerSlotQueues, type ProviderMark } from '@/lib/provider-pool';
import { cn } from '@/lib/utils';

function BrandGlyph({ path, viewBox = '0 0 24 24' }: { path: string; viewBox?: string }) {
  return (
    <svg aria-hidden="true" viewBox={viewBox} className="size-5 fill-current">
      <path d={path} />
    </svg>
  );
}

function useStableRefs(count: number): RefObject<HTMLDivElement | null>[] {
  const refs = useRef<RefObject<HTMLDivElement | null>[]>([]);
  if (refs.current.length !== count) {
    refs.current = Array.from(
      { length: count },
      (_, index) => refs.current[index] ?? { current: null },
    );
  }
  return refs.current;
}

function FlippingProviderCard({
  queue,
  delayMs,
  nodeRef,
}: {
  queue: readonly ProviderMark[];
  delayMs: number;
  nodeRef: RefObject<HTMLDivElement | null>;
}) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [turned, setTurned] = useState(false);
  const mark = queue[index] ?? queue[0];

  useEffect(() => {
    if (reduced === true || queue.length < 2) return;
    let cancelled = false;
    let timer = 0;
    const cycle = () => {
      setTurned(true);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        setIndex((current) => (current + 1) % queue.length);
        setTurned(false);
        timer = window.setTimeout(cycle, 2800);
      }, 240);
    };
    timer = window.setTimeout(cycle, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delayMs, queue.length, reduced]);

  if (!mark) return null;

  return (
    <div
      ref={nodeRef}
      className="flex h-14 w-44 items-center overflow-hidden rounded-card border border-border bg-card px-2.5 [perspective:700px]"
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 transition-transform duration-300 ease-in [transform-style:preserve-3d] motion-reduce:transition-none',
          turned && '[transform:rotateX(90deg)]',
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
          <BrandGlyph path={mark.path} viewBox={mark.viewBox ?? '0 0 24 24'} />
        </span>
        <span className="truncate text-sm font-medium text-foreground">{mark.label}</span>
      </div>
    </div>
  );
}

function AnchorCard({
  nodeRef,
  label,
  hint,
  icon,
  className,
}: {
  nodeRef: RefObject<HTMLDivElement | null>;
  label: string;
  hint?: string;
  icon: ReactNode;
  className?: string;
}) {
  return (
    <div
      ref={nodeRef}
      className={cn(
        'flex h-14 items-center gap-2.5 rounded-card border border-border bg-card px-3',
        className,
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="block truncate text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </div>
  );
}

export function Crossing() {
  const containerRef = useRef<HTMLDivElement>(null);
  const ferryRef = useRef<HTMLDivElement>(null);
  const gatewayRef = useRef<HTMLDivElement>(null);
  const queues = providerSlotQueues();
  const cardRefs = useStableRefs(queues.length);

  return (
    <section id="crossing" className="scroll-mt-16 py-16">
      <Shell>
        <SectionHeading title={crossing.title}>{crossing.lead}</SectionHeading>
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm leading-6 text-muted-foreground">
          {crossing.body}
        </p>

        <div ref={containerRef} className="relative mx-auto mt-12 w-fit max-w-full">
          <div className="grid items-center justify-items-center gap-3 md:grid-cols-[11rem_7rem_7.5rem_5rem_13.5rem] md:gap-x-0">
            <div className="relative z-10 flex flex-col gap-3">
              {queues.map((queue, index) => {
                const nodeRef = cardRefs[index];
                const key = queue[0]?.id ?? String(index);
                if (!nodeRef) return null;
                return (
                  <FlippingProviderCard
                    key={key}
                    queue={queue}
                    delayMs={280 + index * 520}
                    nodeRef={nodeRef}
                  />
                );
              })}
            </div>

            <div className="hidden md:block" aria-hidden="true" />

            <div className="relative z-10 flex justify-center">
              <div
                ref={ferryRef}
                className="flex size-28 flex-col items-center justify-center gap-2 rounded-card border border-border bg-card shadow-[var(--shadow-float)]"
              >
                <FerryMark className="size-12" />
                <span className="text-sm font-semibold">Ferry</span>
              </div>
            </div>

            <div className="hidden md:block" aria-hidden="true" />

            <div className="relative z-10">
              <AnchorCard
                nodeRef={gatewayRef}
                className="w-52"
                label={crossing.gateway}
                hint={crossing.gatewayHint}
                icon={<KeyRound aria-hidden="true" className="size-5" strokeWidth={1.75} />}
              />
            </div>
          </div>

          <RouteSpine
            containerRef={containerRef}
            cardRefs={cardRefs}
            ferryRef={ferryRef}
            gatewayRef={gatewayRef}
          />
        </div>

        <p className="mt-8 text-center text-sm text-muted-foreground">{crossing.note}</p>
      </Shell>
    </section>
  );
}
