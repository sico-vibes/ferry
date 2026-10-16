import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const focus =
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button text-sm font-medium leading-5 transition-colors duration-150 ease-out motion-reduce:transition-none ${focus} disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0`,
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:brightness-110',
        outline:
          'border border-border bg-card text-foreground hover:bg-muted hover:text-foreground',
        ghost: 'bg-transparent text-foreground hover:bg-muted',
      },
      size: {
        md: 'h-9 px-4',
        lg: 'h-11 px-5',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
