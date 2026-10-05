import { SectionHeading, Shell } from '@/components/shell';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { steps } from '@/lib/site';

export function HowItWorks() {
  return (
    <section id="route" className="scroll-mt-16 py-16">
      <Shell>
        <SectionHeading title="How a crossing works">
          Three steps from an empty dock to a session that can change models without changing the
          chat.
        </SectionHeading>
        <ol className="mt-12 grid gap-4 md:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title}>
              <Card className="h-full">
                <CardHeader>
                  <span className="font-mono text-sm text-accent-foreground tabular-nums">
                    0{index + 1}
                  </span>
                  <CardTitle className="mt-3">{step.title}</CardTitle>
                  <CardDescription>{step.body}</CardDescription>
                  {'command' in step ? (
                    <pre className="mt-4 overflow-x-auto rounded-button bg-muted px-3 py-2 font-mono text-sm text-foreground">
                      <code>{step.command}</code>
                    </pre>
                  ) : null}
                </CardHeader>
              </Card>
            </li>
          ))}
        </ol>
      </Shell>
    </section>
  );
}
