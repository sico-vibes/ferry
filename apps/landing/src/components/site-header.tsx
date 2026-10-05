'use client';

import { Menu, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { hero, links, nav } from '@/lib/site';
import { cn } from '@/lib/utils';

const navLinkClass =
  'rounded-button px-3 py-2 text-sm text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-button outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Image
            src="/brand/ferry-icon.png"
            alt=""
            width={32}
            height={32}
            className="size-8 rounded-[10px]"
            priority
          />
          <span className="text-base font-semibold tracking-[-0.01em]">Ferry</span>
        </Link>

        <nav aria-label="Page" className="ml-4 hidden items-center gap-1 md:flex">
          {nav.map((item) => (
            <a key={item.href} href={item.href} className={navLinkClass}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          <a href={links.github} className={cn(buttonVariants({ variant: 'ghost', size: 'md' }))}>
            GitHub
          </a>
          <a
            href={links.download}
            className={cn(buttonVariants({ variant: 'default', size: 'md' }))}
          >
            {hero.primary}
          </a>
        </div>

        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline', size: 'md' }), 'ml-auto md:hidden')}
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {open ? (
            <X aria-hidden="true" strokeWidth={1.75} />
          ) : (
            <Menu aria-hidden="true" strokeWidth={1.75} />
          )}
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Page"
          className="border-t border-border bg-background px-6 py-4 md:hidden"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-1">
            {nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={navLinkClass}
                onClick={() => {
                  setOpen(false);
                }}
              >
                {item.label}
              </a>
            ))}
            <a
              href={links.github}
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'mt-3')}
            >
              GitHub
            </a>
            <a href={links.download} className={cn(buttonVariants({ size: 'lg' }))}>
              {hero.primary}
            </a>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
