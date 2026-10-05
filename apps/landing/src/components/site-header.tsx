'use client';

import { Menu, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { hero, links, nav } from '@/lib/site';
import { cn } from '@/lib/utils';

const navLinkClass =
  'relative z-10 rounded-button px-3 py-2 text-sm text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const sectionIds = nav.map((item) => item.href.slice(1));

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [dense, setDense] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0, visible: false });
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());

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

  useEffect(() => {
    const onScroll = () => {
      setDense(window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    const sections = sectionIds
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) ratios.set(entry.target.id, entry.intersectionRatio);
          else ratios.delete(entry.target.id);
        }
        let next: string | null = null;
        let best = -1;
        for (const [id, ratio] of ratios) {
          if (ratio > best) {
            best = ratio;
            next = id;
          }
        }
        setActive(next);
      },
      { rootMargin: '-18% 0px -52% 0px', threshold: [0, 0.2, 0.45, 0.7] },
    );
    for (const section of sections) observer.observe(section);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const place = () => {
      if (!active) {
        setIndicator((current) => ({ ...current, visible: false }));
        return;
      }
      const link = linkRefs.current.get(active);
      if (!link) return;
      setIndicator({ left: link.offsetLeft, width: link.offsetWidth, visible: true });
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
    };
  }, [active, dense, open]);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 border-b border-border backdrop-blur-md transition-[background-color,box-shadow] duration-200 motion-reduce:transition-none',
        dense ? 'bg-background/95 shadow-[var(--shadow-float)]' : 'bg-background/80',
      )}
    >
      <div
        className={cn(
          'mx-auto flex w-full max-w-6xl items-center gap-4 px-6 transition-[height] duration-200 motion-reduce:transition-none',
          dense ? 'h-14' : 'h-16',
        )}
      >
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

        <nav aria-label="Page" className="relative ml-4 hidden items-center gap-1 md:flex">
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-primary transition-[left,width,opacity] duration-300 ease-out motion-reduce:transition-none',
              indicator.visible ? 'opacity-100' : 'opacity-0',
            )}
            style={{ left: indicator.left, width: indicator.width }}
          />
          {nav.map((item) => {
            const id = item.href.slice(1);
            const current = active === id;
            return (
              <a
                key={item.href}
                href={item.href}
                ref={(node) => {
                  if (node) linkRefs.current.set(id, node);
                  else linkRefs.current.delete(id);
                }}
                aria-current={current ? 'true' : undefined}
                className={cn(navLinkClass, current && 'text-foreground')}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          <a href={links.github} className={cn(buttonVariants({ variant: 'ghost', size: 'md' }))}>
            GitHub
          </a>
          <a
            href={links.download}
            className={cn(buttonVariants({ variant: 'default', size: 'md' }), 'download-sheen')}
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
          className="border-t border-border bg-background/95 px-6 py-4 backdrop-blur-md md:hidden"
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
            <a
              href={links.download}
              className={cn(buttonVariants({ size: 'lg' }), 'download-sheen')}
            >
              {hero.primary}
            </a>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
