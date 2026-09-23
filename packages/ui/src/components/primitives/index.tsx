import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { siGithub, siSupabase } from 'simple-icons';
import { BadgeCheck, Plus, Sparkles } from 'lucide-react';
import { GlowLine } from '../../effects/GlowLine';
import { cn } from '../../lib/cn';

const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app';

const iconButtonStyles = cva(
  `inline-flex shrink-0 items-center justify-center transition duration-150 ease-out hover:bg-white/[0.04] active:scale-[.98] disabled:pointer-events-none disabled:opacity-40 ${focus}`,
  {
    variants: {
      variant: {
        ghost: 'rounded-pill text-text-2 hover:text-text-1',
        tile: 'rounded-tile border border-border-hair bg-rail-tile text-text-2 shadow-[inset_0_1px_0_var(--highlight-top)] hover:border-border-strong hover:text-text-1',
        circle:
          'rounded-full border border-border-hair bg-icon-circle text-text-2 hover:text-text-1',
      },
      size: { sm: 'size-8', md: 'size-9' },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
);

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof iconButtonStyles> & { label: string };

export function IconButton({
  label,
  variant,
  size,
  className,
  children,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={cn(iconButtonStyles({ variant, size }), className)}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}

const pillStyles = cva(
  `inline-flex shrink-0 items-center justify-center gap-2 rounded-pill border px-3 text-label font-medium transition duration-150 ease-out hover:brightness-110 active:scale-[.98] disabled:pointer-events-none disabled:opacity-40 ${focus}`,
  {
    variants: {
      variant: {
        outline: 'border-border-soft bg-transparent text-text-1',
        dark: 'border-border-soft bg-pill text-text-1',
        'blue-tint': 'border-transparent bg-blue-tint text-link',
        send: 'border-transparent bg-[image:var(--grad-send)] text-[var(--text-on-send)] font-semibold',
        'warm-outline': 'border-[var(--border-warm)] bg-pill text-text-1',
      },
      size: { sm: 'h-7 text-meta', md: 'h-[30px]', lg: 'h-[34px] text-body' },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export type PillProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof pillStyles> & { leadingIcon?: ReactNode; trailingIcon?: ReactNode };

export function Pill({
  variant,
  size,
  leadingIcon,
  trailingIcon,
  className,
  children,
  type = 'button',
  ...props
}: PillProps) {
  return (
    <button className={cn(pillStyles({ variant, size }), className)} type={type} {...props}>
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}

export function MiniAdd({
  label = 'Add',
  onClick,
  className,
}: {
  label?: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        `inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-blue-mini text-white transition hover:brightness-110 active:scale-[.98] ${focus}`,
        className,
      )}
      onClick={onClick}
      type="button"
    >
      <Plus aria-hidden="true" size={10} strokeWidth={2.5} />
    </button>
  );
}

export function KbdChip({
  children = 'Ctrl F',
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        'rounded-md bg-raised px-1.5 py-0.5 text-meta font-medium text-text-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function VerifiedBadge({ className }: { className?: string }) {
  return (
    <BadgeCheck
      aria-label="Verified"
      className={cn('size-[14px] fill-blue-500 text-white', className)}
      role="img"
      strokeWidth={2.5}
    />
  );
}

const brandIcons: Record<string, typeof siGithub | undefined> = {
  github: siGithub,
  supabase: siSupabase,
};
export function BrandIcon({
  slug,
  label,
  className,
}: {
  slug: string;
  label?: string;
  className?: string;
}) {
  const icon = brandIcons[slug.toLowerCase()];
  const name = label ?? slug;
  return (
    <span
      aria-label={name}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border-hair bg-white/[0.06] text-text-1',
        className,
      )}
      role="img"
    >
      {icon ? (
        <svg aria-hidden="true" className="size-[14px] fill-current" viewBox="0 0 24 24">
          <path d={icon.path} />
        </svg>
      ) : (
        <span aria-hidden="true" className="text-label font-semibold uppercase">
          {slug.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

const newChatStyles = cva(
  `group relative inline-flex items-center justify-center gap-2 overflow-visible rounded-pill border border-border-soft bg-pill-dark font-medium text-text-1 transition duration-150 ease-out hover:bg-white/[0.04] active:scale-[.98] ${focus}`,
  {
    variants: { size: { lg: 'h-10 w-full text-body', sm: 'h-8 px-3 text-label' } },
    defaultVariants: { size: 'lg' },
  },
);
export type NewChatButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof newChatStyles>;
export function NewChatButton({
  size,
  className,
  children = 'New Chat',
  type = 'button',
  ...props
}: NewChatButtonProps) {
  const gradientId = `ferry-sparkle-${useId().replaceAll(':', '')}`;
  return (
    <button className={cn(newChatStyles({ size }), className)} type={type} {...props}>
      <Plus aria-hidden="true" size={16} strokeWidth={1.75} />
      <span>{children}</span>
      <svg aria-hidden="true" className="size-[14px]" viewBox="0 0 24 24">
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1">
            <stop stopColor="var(--blue-500)" />
            <stop offset="1" stopColor="var(--warn)" />
          </linearGradient>
        </defs>
        <Sparkles fill={`url(#${gradientId})`} stroke={`url(#${gradientId})`} size={14} />
      </svg>
      <GlowLine
        orientation="horizontal"
        from="15%"
        to="85%"
        className="bottom-[-1px] opacity-80 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

export const focusRingClass = focus;
