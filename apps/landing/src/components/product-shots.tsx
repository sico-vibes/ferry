import Image from 'next/image';
import { SectionHeading, Shell } from '@/components/shell';
import { dock } from '@/lib/site';

export function ProductShots() {
  return (
    <section id="dock" className="scroll-mt-16 py-16">
      <Shell>
        <SectionHeading title={dock.title}>{dock.lead}</SectionHeading>
        <figure className="mx-auto mt-12 max-w-5xl">
          <div className="overflow-hidden rounded-card border border-border bg-card shadow-[var(--shadow-float)]">
            <Image
              src="/screenshots/routing.png"
              alt={dock.routingAlt}
              width={1440}
              height={900}
              sizes="(min-width: 1024px) 960px, 100vw"
              className="h-auto w-full"
            />
          </div>
          <figcaption className="mt-3 text-center text-sm text-muted-foreground">
            {dock.routingCaption}
          </figcaption>
        </figure>
      </Shell>
    </section>
  );
}
