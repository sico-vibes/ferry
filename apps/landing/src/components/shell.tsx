import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Shell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-6', className)}>{children}</div>;
}

export function SectionHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <h2 className="text-3xl leading-tight font-semibold tracking-[-0.01em] text-balance text-foreground sm:text-4xl">
        {title}
      </h2>
      <p className="mt-4 text-base leading-7 text-pretty text-muted-foreground">{children}</p>
    </div>
  );
}
