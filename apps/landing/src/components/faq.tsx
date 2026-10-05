import { Reveal } from '@/components/reveal';
import { SectionHeading, Shell } from '@/components/shell';
import { Spotlight } from '@/components/spotlight';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { faq } from '@/lib/site';

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-14 py-16">
      <Shell>
        <Reveal>
          <SectionHeading title="Questions before you board">
            Short answers. Provider limits still belong to the providers.
          </SectionHeading>
          <Accordion type="single" collapsible className="mx-auto mt-10 max-w-3xl">
            {faq.map((item) => (
              <Spotlight key={item.question}>
                <AccordionItem value={item.question}>
                  <AccordionTrigger>{item.question}</AccordionTrigger>
                  <AccordionContent>{item.answer}</AccordionContent>
                </AccordionItem>
              </Spotlight>
            ))}
          </Accordion>
        </Reveal>
      </Shell>
    </section>
  );
}
