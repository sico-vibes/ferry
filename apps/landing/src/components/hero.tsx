import Image from 'next/image';
import { GradientWavesBackground } from '@/components/gradient-waves-background';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { dock, hero, links } from '@/lib/site';
import { cn } from '@/lib/utils';

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <GradientWavesBackground />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: 'var(--hero-scrim)' }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background"
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-16 pb-8 text-center sm:pt-24">
        <Badge>{hero.badge}</Badge>
        <h1 className="mt-6 max-w-4xl text-4xl leading-tight font-semibold tracking-[-0.01em] text-balance text-foreground sm:text-6xl">
          Your <span className="text-accent-foreground">ferry</span> across free AI.
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-7 font-medium text-foreground sm:text-xl">
          {hero.support}
        </p>
        <p className="mt-4 max-w-2xl text-base leading-7 text-pretty text-muted-foreground">
          {hero.body}
        </p>

        <div className="mt-8 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
          <a
            href={links.download}
            className={cn(buttonVariants({ size: 'lg' }), 'w-full sm:w-auto')}
          >
            {hero.primary}
          </a>
          <a
            href={links.github}
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full sm:w-auto')}
          >
            {hero.secondary}
          </a>
        </div>
        <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">{hero.honest}</p>

        <figure className="mt-12 w-full max-w-5xl">
          <div className="overflow-hidden rounded-card border border-border bg-card shadow-[var(--shadow-float)]">
            <Image
              src="/screenshots/home.png"
              alt={dock.homeAlt}
              width={1440}
              height={900}
              priority
              sizes="(min-width: 1024px) 960px, 100vw"
              className="h-auto w-full"
            />
          </div>
          <figcaption className="mt-3 text-sm text-muted-foreground">{dock.homeCaption}</figcaption>
        </figure>
        <p className="mt-4 max-w-2xl text-xs leading-5 text-muted-foreground">{hero.smartScreen}</p>
      </div>
    </section>
  );
}
