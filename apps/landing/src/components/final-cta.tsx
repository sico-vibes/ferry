import { Reveal } from '@/components/reveal';
import { SmartTip } from '@/components/smart-tip';
import { buttonVariants } from '@/components/ui/button';
import { finalCta, hero, links } from '@/lib/site';
import { cn } from '@/lib/utils';

export function FinalCta() {
  return (
    <section className="py-16">
      <div className="mx-auto w-full max-w-6xl px-6">
        <Reveal>
          <div className="rounded-card border border-border bg-card px-6 py-12 text-center sm:px-12">
            <h2 className="text-3xl leading-tight font-semibold tracking-[-0.01em] text-balance sm:text-4xl">
              {finalCta.title}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-muted-foreground">
              {finalCta.body}
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={links.download}
                className={cn(buttonVariants({ size: 'lg' }), 'download-sheen')}
              >
                {finalCta.primary}
              </a>
              <a
                href={links.docs}
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
              >
                {finalCta.secondary}
              </a>
            </div>
            <SmartTip>{hero.smartScreen}</SmartTip>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
