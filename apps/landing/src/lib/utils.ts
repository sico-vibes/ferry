import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(...classes));
}

export const textLinkClass =
  'rounded-sm font-medium text-accent-foreground underline decoration-accent-foreground/40 underline-offset-4 outline-none hover:decoration-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
