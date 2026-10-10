import type { ReactNode } from 'react';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata } from 'next';
import { hero, links } from '@/lib/site';
import { getSiteUrl } from '@/lib/seo';
import './globals.css';

const title = 'Ferry: your ferry across free AI';
const description = `${hero.support} ${hero.body}`;

export const metadata: Metadata = {
  metadataBase: getSiteUrl(),
  title: { default: title, template: '%s · Ferry' },
  description,
  applicationName: 'Ferry',
  keywords: [
    'Ferry',
    'coding agent',
    'free AI providers',
    'BYOK',
    'Windows',
    'CLI',
    'model routing',
  ],
  openGraph: {
    title,
    description,
    url: '/',
    siteName: 'Ferry',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description: hero.support,
  },
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Ferry',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    downloadUrl: links.download,
    description: hero.body,
    url: getSiteUrl().toString(),
  };

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-svh bg-background font-sans text-foreground antialiased">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-button focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
        >
          Skip to content
        </a>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}
