'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Reveal } from '@/components/reveal';
import { SectionHeading, Shell } from '@/components/shell';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { steps } from '@/lib/site';

export function HowItWorks() {
  const sectionRef = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;
    if (reduced === true) {
      setProgress(1);
      return;
    }

    let frame = 0;
    let watching = false;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const start = window.innerHeight * 0.82;
      const distance = Math.max(rect.height, 1) + window.innerHeight * 0.2;
      const traveled = start - rect.top;
      setProgress(Math.min(1, Math.max(0, traveled / distance)));
    };
    const onScroll = () => {
      if (!watching || frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        watching = entry?.isIntersecting ?? false;
        if (watching) measure();
      },
      { threshold: 0 },
    );
    observer.observe(node);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [reduced]);

  const scale = reduced === true ? 1 : progress;

  return (
    <section ref={sectionRef} id="route" className="scroll-mt-14 py-16">
      <Shell>
        <Reveal>
          <SectionHeading title="How a crossing works">
            Three steps from an empty dock to a session that can change models without changing the
            chat.
          </SectionHeading>
          <ol className="relative mx-auto mt-12 max-w-3xl">
            <div
              aria-hidden="true"
              className="absolute top-3 bottom-3 left-[15px] w-px bg-border"
            />
            <div
              aria-hidden="true"
              className="step-rail-fill absolute top-3 bottom-3 left-[15px] w-px bg-primary"
              style={{ transform: `scaleY(${String(scale)})` }}
            />
            {steps.map((step, index) => (
              <li key={step.title} className="relative pb-6 pl-14 last:pb-0">
                <span className="absolute top-4 left-0 flex size-8 items-center justify-center rounded-full border border-border bg-card font-mono text-xs text-accent-foreground tabular-nums">
                  0{index + 1}
                </span>
                <Card>
                  <CardHeader>
                    <CardTitle>{step.title}</CardTitle>
                    <CardDescription>{step.body}</CardDescription>
                    {'command' in step ? (
                      <pre className="mt-4 overflow-x-auto rounded-button border border-border bg-muted/60 px-3 py-2 font-mono text-sm text-foreground backdrop-blur-md">
                        <code>{step.command}</code>
                      </pre>
                    ) : null}
                  </CardHeader>
                </Card>
              </li>
            ))}
          </ol>
        </Reveal>
      </Shell>
    </section>
  );
}
