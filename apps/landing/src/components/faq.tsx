import { SectionHeading, Shell } from '@/components/shell';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { faq } from '@/lib/site';

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-16 py-16">
      <Shell>
        <SectionHeading title="Questions before you board">
          Short answers. Provider limits still belong to the providers.
        </SectionHeading>
        <Accordion type="single" collapsible className="mx-auto mt-10 max-w-3xl">
          {faq.map((item) => (
            <AccordionItem key={item.question} value={item.question}>
              <AccordionTrigger>{item.question}</AccordionTrigger>
              <AccordionContent>{item.answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Shell>
    </section>
  );
}
