import {
  HardDrive,
  KeyRound,
  MonitorSmartphone,
  Route,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SectionHeading, Shell } from '@/components/shell';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { features } from '@/lib/site';

const icons: Record<(typeof features)[number]['title'], LucideIcon> = {
  'Free providers hub': Waypoints,
  'Smart routing': Route,
  'Key health and rotation': KeyRound,
  'Desktop + CLI': MonitorSmartphone,
  'Local-first': HardDrive,
  'Honest BYOK': ShieldCheck,
};

export function Features() {
  return (
    <section id="features" className="scroll-mt-16 py-16">
      <Shell>
        <SectionHeading title="What the gateway carries">
          One place to dock your keys, choose a route, and keep working when a provider runs out of
          room.
        </SectionHeading>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const Icon = icons[feature.title];
            return (
              <Card key={feature.title}>
                <CardHeader>
                  <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
                    <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
                  </span>
                  <CardTitle className="mt-3">{feature.title}</CardTitle>
                  <CardDescription>{feature.body}</CardDescription>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      </Shell>
    </section>
  );
}
