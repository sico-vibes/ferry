import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';
import { cva } from 'class-variance-authority';
import {
  Compass,
  Crown,
  FlaskConical,
  Library,
  LogOut,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Share2,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { FerryMark } from '../../brand/FerryMark';
import { GlowLine } from '../../effects/GlowLine';
import { cn } from '../../lib/cn';
import { DropdownMenu } from '../forms';
import { BrandIcon, IconButton, MiniAdd, Pill, VerifiedBadge, focusRingClass } from '../primitives';

const tileStyles = cva(
  'flex min-h-[64px] w-14 flex-col items-center gap-1.5 text-[10.5px] leading-[14px] font-medium transition duration-150 ease-out',
  {
    variants: { active: { true: 'text-text-1', false: 'text-text-3 hover:text-text-2' } },
    defaultVariants: { active: false },
  },
);
export function RailTile({
  icon: Icon,
  label,
  active = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(tileStyles({ active }), focusRingClass)}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          'relative flex size-11 items-center justify-center rounded-tile border transition',
          active
            ? 'border-border-strong bg-rail-tile-active text-text-1 shadow-[inset_0_1px_0_var(--highlight-top)]'
            : 'border-border-hair bg-rail-tile text-text-2 hover:bg-rail-tile-active',
        )}
      >
        <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
      </span>
      <span>{label}</span>
    </button>
  );
}

export { FerryMark };

export function IconRail({
  active,
  onNavigate,
  onNew,
  onAdd,
  onToggleTheme,
  logo,
}: {
  active: 'chats' | 'library' | 'explore' | null;
  onNavigate?: (to: 'chats' | 'library' | 'explore') => void;
  onNew?: () => void;
  onAdd?: () => void;
  onToggleTheme?: () => void;
  logo?: ReactNode;
}) {
  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-16 shrink-0 flex-col items-center bg-transparent px-1 py-3"
    >
      <div className="mb-5 flex h-8 items-center justify-center">
        {logo ?? <FerryMark size={28} variant="icon" />}
      </div>
      <button
        aria-label="New chat"
        className={`mb-5 flex size-9 items-center justify-center rounded-full bg-blue-600 text-white shadow-[0_0_18px_var(--blue-glow)] transition hover:brightness-110 active:scale-[.98] ${focusRingClass}`}
        onClick={onNew}
        type="button"
      >
        <Pencil aria-hidden="true" size={16} strokeWidth={1.75} />
      </button>
      <span aria-hidden="true" className="mb-5 h-px w-8 bg-border-soft" />
      <div className="flex flex-col items-center gap-[18px]">
        <RailTile
          active={active === 'chats'}
          icon={MessagesSquare}
          label="Chats"
          onClick={() => {
            onNavigate?.('chats');
          }}
        />
        <RailTile
          active={active === 'library'}
          icon={Library}
          label="Library"
          onClick={() => {
            onNavigate?.('library');
          }}
        />
        <RailTile
          active={active === 'explore'}
          icon={Compass}
          label="Explore"
          onClick={() => {
            onNavigate?.('explore');
          }}
        />
      </div>
      <button
        aria-label="Add"
        className={`mt-5 flex size-10 items-center justify-center rounded-full border border-dashed border-border-strong text-text-2 transition hover:bg-icon-circle ${focusRingClass}`}
        onClick={onAdd}
        type="button"
      >
        <Plus aria-hidden="true" size={16} />
      </button>
      <div className="mt-auto flex w-full flex-col items-center gap-3">
        <span className="flex w-full flex-col items-center gap-1 rounded-md border border-border-hair px-0.5 py-1 text-meta leading-4 text-text-3">
          <FlaskConical aria-hidden="true" size={13} strokeWidth={1.75} />
          <span>Demo data</span>
        </span>
        <span aria-hidden="true" className="h-px w-8 bg-[var(--fade-line)]" />
        <button
          aria-label="Toggle theme"
          className={`flex size-9 items-center justify-center rounded-full bg-[image:var(--bg-theme-toggle)] text-blue-500 shadow-[0_0_14px_var(--blue-glow)] ${focusRingClass}`}
          onClick={onToggleTheme}
          type="button"
        >
          <Sun aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Sign out"
          className={`flex size-8 items-center justify-center rounded-full text-text-3 hover:bg-icon-circle hover:text-text-2 ${focusRingClass}`}
          type="button"
        >
          <LogOut aria-hidden="true" size={18} />
        </button>
      </div>
    </nav>
  );
}

export function SidebarPanel({
  header,
  children,
  footer,
  className,
}: {
  header?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-border-hair bg-[var(--bg-panel-grad)] p-4 shadow-[inset_0_1px_0_var(--highlight-top)]',
        className,
      )}
    >
      <GlowLine orientation="vertical" from="30%" to="92%" className="right-0 z-10" />
      {header && <header className="mb-5 flex shrink-0 items-center">{header}</header>}
      <div className="min-h-0 flex-1">{children}</div>
      {footer && <footer className="mt-auto shrink-0 pt-3">{footer}</footer>}
    </section>
  );
}

export function SidebarSection({
  label,
  action,
  children,
  className,
}: {
  label: string;
  action?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex min-h-7 items-center justify-between">
        <h2 className="text-meta font-medium text-text-3">{label}</h2>
        {action && <MiniAdd label={`Add to ${label}`} onClick={action} />}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

export function SidebarItem({
  icon: Icon,
  label,
  active = false,
  activeStyle = 'gradient',
  onClick,
  showMenu = true,
  menu,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  activeStyle?: 'gradient' | 'neutral';
  shimmer?: boolean;
  onClick?: () => void;
  showMenu?: boolean;
  menu?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'group relative flex h-9 items-center gap-2.5 overflow-hidden rounded-item px-2.5 text-[13px] leading-5 font-normal transition duration-150 ease-out',
        active
          ? activeStyle === 'gradient'
            ? 'text-white shadow-[inset_0_1px_0_var(--highlight-top)]'
            : 'bg-raised text-text-1 shadow-[inset_0_1px_0_var(--highlight-top)]'
          : 'text-text-1 hover:bg-icon-circle',
      )}
      style={
        active && activeStyle === 'gradient'
          ? {
              backgroundImage: 'var(--grad-signature)',
            }
          : undefined
      }
    >
      <button
        aria-current={active ? 'true' : undefined}
        className={`flex min-w-0 flex-1 items-center gap-2.5 text-left ${focusRingClass}`}
        onClick={onClick}
        type="button"
      >
        <Icon
          aria-hidden="true"
          className={cn(active ? 'text-white' : 'text-text-2')}
          size={16}
          strokeWidth={1.75}
        />
        <span className="truncate">{label}</span>
      </button>
      {menu ??
        (showMenu && (
          <button
            aria-label={`More actions for ${label}`}
            className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full transition hover:bg-icon-circle focus-visible:opacity-100 ${active && activeStyle === 'gradient' ? 'text-white hover:text-white' : 'text-text-2 hover:text-text-1'} ${focusRingClass}`}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" size={16} />
          </button>
        ))}
    </div>
  );
}

export function IntegrationItem({
  slug,
  label,
  status = 'connected',
}: {
  slug: string;
  label: string;
  status?: 'connected' | 'disconnected' | 'error';
}) {
  return (
    <div className="flex h-10 items-center gap-3 px-2">
      <BrandIcon
        label={label}
        slug={slug}
        {...(status === 'disconnected' ? { className: 'opacity-60' } : {})}
      />
      <span
        className={cn(
          'truncate text-[13px] leading-5 font-medium',
          status === 'disconnected' ? 'text-text-2' : 'text-text-1',
        )}
      >
        {label}
      </span>
      {status === 'connected' && <VerifiedBadge className="ml-[-6px]" />}
      {status === 'error' && (
        <span aria-label="Connection error" className="size-2 rounded-full bg-danger" role="img" />
      )}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
  icon: LucideIcon;
  status?: 'idle' | 'running' | 'awaiting_approval' | 'error';
  successPulse?: boolean;
}
export function TabsBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onAdd,
  rightCluster,
}: {
  tabs: TabItem[];
  activeId: string;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onAdd?: () => void;
  rightCluster?: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'Home') {
      event.preventDefault();
      refs.current[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      refs.current[tabs.length - 1]?.focus();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    refs.current[next]?.focus();
    const tab = tabs[next];
    if (tab) onSelect?.(tab.id);
  }
  return (
    <div className="flex h-11 min-w-0 items-center justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <div
          aria-label="Open tabs"
          className="tabs-list flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
          role="tablist"
        >
          {tabs.map((tab, index) => {
            const Icon = tab.icon;
            const selected = tab.id === activeId;
            return (
              <div
                className={cn(
                  'group inline-flex h-[34px] max-w-56 shrink-0 items-center rounded-pill border transition hover:bg-icon-circle',
                  selected
                    ? 'border-border-strong bg-raised text-text-1'
                    : 'border-border-hair text-text-2',
                )}
                key={tab.id}
                role="presentation"
              >
                <button
                  aria-selected={selected}
                  title="Select tab"
                  className={`inline-flex h-full min-w-0 items-center gap-2 rounded-pill px-3.5 text-body font-medium ${focusRingClass}`}
                  onAuxClick={(event) => {
                    if (event.button === 1) onClose?.(tab.id);
                  }}
                  onClick={() => {
                    onSelect?.(tab.id);
                  }}
                  onKeyDown={(event) => {
                    onKeyDown(event, index);
                  }}
                  ref={(element) => {
                    refs.current[index] = element;
                  }}
                  role="tab"
                  tabIndex={selected ? 0 : -1}
                  type="button"
                >
                  <Icon aria-hidden="true" size={14} strokeWidth={1.75} />
                  <span className="truncate">{tab.label}</span>
                  {(tab.successPulse ?? Boolean(tab.status && tab.status !== 'idle')) && (
                    <span
                      aria-label={
                        tab.successPulse
                          ? 'Completed successfully'
                          : tab.status === 'awaiting_approval'
                            ? 'Awaiting approval'
                            : tab.status
                      }
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        tab.status === 'running' &&
                          'animate-pulse bg-blue-500 motion-reduce:animate-none',
                        tab.status === 'awaiting_approval' && 'bg-warn',
                        tab.status === 'error' && 'bg-danger',
                        tab.successPulse &&
                          'bg-blue-500 tab-success-pulse motion-reduce:animate-none',
                      )}
                      role="img"
                    />
                  )}
                </button>
                {onClose && (
                  <button
                    aria-label={`Close ${tab.label}`}
                    title={`Close tab · Ctrl+W`}
                    className={`mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-text-2 opacity-0 transition hover:bg-icon-circle hover:text-text-1 group-hover:opacity-100 group-focus-within:opacity-100 ${focusRingClass}`}
                    onClick={() => {
                      onClose(tab.id);
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          aria-label="Add tab"
          title="New chat · Ctrl+N"
          className={`flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border-hair bg-icon-circle text-text-2 hover:bg-raised ${focusRingClass}`}
          onClick={onAdd}
          type="button"
        >
          <Plus aria-hidden="true" size={16} />
        </button>
      </div>
      {rightCluster && <div className="flex shrink-0 items-center">{rightCluster}</div>}
    </div>
  );
}

export function TopRightCluster({
  onConfiguration,
  onShare,
  onAccount,
}: {
  onConfiguration?: () => void;
  onShare?: () => void;
  onAccount?: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <IconButton label="More options" size="sm">
        <MoreHorizontal size={18} />
      </IconButton>
      <Pill variant="dark" size="lg" onClick={onConfiguration}>
        Configuration <Settings aria-hidden="true" size={14} />
      </Pill>
      <Pill variant="warm-outline" size="lg" onClick={onShare}>
        Share <Share2 aria-hidden="true" size={14} />
      </Pill>
      <DropdownMenu
        trigger={
          <button
            aria-label="Account menu"
            className={`ml-1 flex size-9 items-center justify-center rounded-full bg-[image:var(--grad-avatar)] text-[var(--text-on-send)] shadow-[var(--shadow-avatar)] ${focusRingClass}`}
            type="button"
          >
            <Crown aria-hidden="true" size={14} strokeWidth={2} />
          </button>
        }
        items={[{ label: 'Settings', icon: <Settings size={14} />, onSelect: () => onAccount?.() }]}
      />
    </div>
  );
}
