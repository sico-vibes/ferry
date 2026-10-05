'use client';

import { Monitor, Terminal } from 'lucide-react';
import { useRef, type ReactNode, type RefObject } from 'react';
import { siAnthropic, siGooglegemini, siMistralai, siOpenrouter } from 'simple-icons';
import { AnimatedBeam } from '@/components/animated-beam';
import { FerryMark } from '@/components/ferry-mark';
import { SectionHeading, Shell } from '@/components/shell';
import { crossing } from '@/lib/site';
import { cn } from '@/lib/utils';

interface ProviderNode {
  id: string;
  label: string;
  icon: ReactNode;
}

function BrandGlyph({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-current">
      <path d={path} />
    </svg>
  );
}

const providers: ProviderNode[] = [
  { id: 'gemini', label: 'Gemini', icon: <BrandGlyph path={siGooglegemini.path} /> },
  { id: 'groq', label: 'Groq', icon: <span className="font-mono text-xs font-medium">Gq</span> },
  { id: 'openrouter', label: 'OpenRouter', icon: <BrandGlyph path={siOpenrouter.path} /> },
  { id: 'mistral', label: 'Mistral', icon: <BrandGlyph path={siMistralai.path} /> },
  {
    id: 'openai',
    label: 'OpenAI',
    icon: <span className="font-mono text-xs font-medium">OA</span>,
  },
  { id: 'anthropic', label: 'Anthropic', icon: <BrandGlyph path={siAnthropic.path} /> },
];

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

function NodeCard({
  nodeRef,
  label,
  icon,
  className,
}: {
  nodeRef: RefObject<HTMLDivElement | null>;
  label: string;
  icon: ReactNode;
  className?: string;
}) {
  return (
    <div
      ref={nodeRef}
      className={cn(
        'flex items-center gap-3 rounded-card border border-border bg-card px-3 py-2 text-left',
        className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        {icon}
      </span>
      <span className="text-sm font-medium text-foreground">{label}</span>
    </div>
  );
}

export function Crossing() {
  const containerRef = useRef<HTMLDivElement>(null);
  const providerRefs = useStableRefs(providers.length);
  const centerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<HTMLDivElement>(null);
  const cliRef = useRef<HTMLDivElement>(null);
  const curves = [-48, -24, -8, 8, 24, 48];

  return (
    <section id="crossing" className="scroll-mt-16 py-16">
      <Shell>
        <SectionHeading title={crossing.title}>{crossing.lead}</SectionHeading>
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm leading-6 text-muted-foreground">
          {crossing.body}
        </p>

        <div
          ref={containerRef}
          className="relative mt-12 grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-8"
        >
          <div className="relative z-10 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-1">
            {providers.map((provider, index) => {
              const nodeRef = providerRefs[index];
              if (!nodeRef) return null;
              return (
                <NodeCard
                  key={provider.id}
                  nodeRef={nodeRef}
                  label={provider.label}
                  icon={provider.icon}
                />
              );
            })}
          </div>

          <div className="relative z-10 flex justify-center">
            <div
              ref={centerRef}
              className="flex size-28 flex-col items-center justify-center gap-2 rounded-card border border-border bg-card shadow-[var(--shadow-float)]"
            >
              <FerryMark className="size-12" />
              <span className="text-sm font-semibold">Ferry</span>
            </div>
          </div>

          <div className="relative z-10 grid grid-cols-2 gap-3 md:grid-cols-1">
            <NodeCard
              nodeRef={sessionRef}
              label="Desktop session"
              icon={<Monitor aria-hidden="true" className="size-5" strokeWidth={1.75} />}
            />
            <NodeCard
              nodeRef={cliRef}
              label="CLI"
              icon={<Terminal aria-hidden="true" className="size-5" strokeWidth={1.75} />}
            />
          </div>

          {providers.map((provider, index) => {
            const fromRef = providerRefs[index];
            if (!fromRef) return null;
            return (
              <AnimatedBeam
                key={provider.id}
                containerRef={containerRef}
                fromRef={fromRef}
                toRef={centerRef}
                curvature={curves[index] ?? 0}
                duration={4.8 + index * 0.25}
                delay={index * 0.15}
              />
            );
          })}
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={centerRef}
            toRef={sessionRef}
            curvature={-20}
            duration={4.6}
            reverse
          />
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={centerRef}
            toRef={cliRef}
            curvature={20}
            duration={5.2}
            delay={0.2}
            reverse
          />
        </div>
        <p className="mt-8 text-center text-sm text-muted-foreground">{crossing.note}</p>
      </Shell>
    </section>
  );
}
