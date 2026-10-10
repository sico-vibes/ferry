import {
  HardDrive,
  KeyRound,
  MonitorSmartphone,
  Route,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Reveal } from '@/components/reveal';
import { SectionHeading, Shell } from '@/components/shell';
import { Spotlight } from '@/components/spotlight';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { features } from '@/lib/site';
import { cn } from '@/lib/utils';

const icons: Record<(typeof features)[number]['title'], LucideIcon> = {
  'Free providers hub': Waypoints,
  'Smart routing': Route,
  'Key health and rotation': KeyRound,
  'Desktop + CLI': MonitorSmartphone,
  'Local-first': HardDrive,
  'Honest BYOK': ShieldCheck,
};

const bentoSpans = [
  'sm:col-span-2 lg:col-span-2 lg:row-span-2',
  '',
  '',
  'lg:col-span-2',
  'lg:col-span-2',
  'sm:col-span-2 lg:col-span-2',
] as const;

export function Features() {
  return (
    <section id="features" className="scroll-mt-14 py-16">
      <Shell>
        <Reveal>
          <SectionHeading title="What the gateway carries">
            One place to dock your keys, choose a route, and keep working when a provider runs out
            of room.
          </SectionHeading>
          <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature, index) => {
              const Icon = icons[feature.title];
              const span = bentoSpans[index] ?? '';
              return (
                <Spotlight key={feature.title} className={cn('h-full rounded-card', span)}>
                  <Card className="bento-tile h-full">
                    <CardHeader>
                      <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
                        <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
                      </span>
                      <CardTitle className="mt-3">{feature.title}</CardTitle>
                      <CardDescription>{feature.body}</CardDescription>
                    </CardHeader>
                  </Card>
                </Spotlight>
              );
            })}
          </div>
        </Reveal>
      </Shell>
    </section>
  );
}
