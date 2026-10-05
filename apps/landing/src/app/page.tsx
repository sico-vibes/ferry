import { Crossing } from '@/components/crossing';
import { Faq } from '@/components/faq';
import { Features } from '@/components/features';
import { FinalCta } from '@/components/final-cta';
import { Hero } from '@/components/hero';
import { HowItWorks } from '@/components/how-it-works';
import { ProductShots } from '@/components/product-shots';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main id="content">
        <Hero />
        <Crossing />
        <Features />
        <HowItWorks />
        <ProductShots />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
