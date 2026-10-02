import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowUpRight,
  BookOpenText,
  Code2,
  ChevronDown,
  FlaskConical,
  FolderOpen,
  GitPullRequest,
  Lightbulb,
  Link,
  Map,
  MoreHorizontal,
  Pin,
  Send,
  Sparkles,
  Share2,
  Square,
  Timer,
  TestTube,
  Wand2,
} from 'lucide-react';
import { AmbientGlow } from '../../effects/AmbientGlow';
import { DotGrid } from '../../effects/DotGrid';
import { GradientText } from '../../effects/GradientText';
import { cn } from '../../lib/cn';
import { Spotlight } from '../../effects/Spotlight';
import { FerryMark } from '../nav';
import { Pill, IconButton, focusRingClass } from '../primitives';
import { DropdownMenu } from '../forms';

export function CanvasPanel({
  children,
  header,
  dots = true,
  className,
  overflowContained = false,
}: {
  children?: ReactNode;
  header?: ReactNode;
  dots?: boolean;
  className?: string;
  overflowContained?: boolean;
}) {
  return (
    <section
      data-audit-overflow={overflowContained ? 'intentional' : undefined}
      className={cn(
        'relative flex min-h-0 flex-col overflow-hidden rounded-canvas border border-border-hair bg-canvas p-5 shadow-[inset_0_1px_0_var(--highlight-top)]',
        className,
      )}
    >
      <AmbientGlow
        className="absolute inset-0"
        glows={[
          { color: 'warm', x: '10%', y: '0%', size: 520 },
          { color: 'blue', x: '68%', y: '0%', size: 600 },
        ]}
      />
      {dots && <DotGrid className="absolute inset-0" centerX="50%" centerY="46%" />}
      {header && (
        <header className="relative z-10 flex h-8 w-full shrink-0 items-center justify-between">
          {header}
        </header>
      )}
      <div className="relative z-10 flex min-h-0 min-w-0 w-full flex-1 flex-col">{children}</div>
    </section>
  );
}

export function ModelPickerTrigger({
  mode,
  modelName,
  onClick,
}: {
  mode: 'auto' | 'manual';
  modelName: string;
  onClick?: () => void;
}) {
  return (
    <button
      className={`inline-flex items-center gap-2 rounded-pill px-2 py-1 text-body font-medium text-text-1 hover:bg-icon-circle ${focusRingClass}`}
      onClick={onClick}
      type="button"
    >
      <FerryMark className="text-text-2" decorative size={14} variant="mono" />
      <span>
        {mode === 'auto' ? 'Auto' : 'Manual'} · {modelName}
      </span>
      <ChevronDown aria-hidden="true" size={14} />
    </button>
  );
}

export function CanvasHeaderActions({
  onMore,
  onLink,
  onShare,
  moreItems,
}: {
  onMore?: () => void;
  onLink?: () => void;
  onShare?: () => void;
  moreItems?: {
    label?: string;
    separator?: boolean;
    onSelect?: () => void;
    shortcut?: string;
    icon?: ReactNode;
    danger?: boolean;
  }[];
}) {
  return (
    <div className="flex items-center gap-2">
      {moreItems ? (
        <DropdownMenu
          trigger={
            <button
              aria-label="More canvas actions"
              className={`inline-flex size-8 items-center justify-center rounded-full text-text-2 hover:bg-icon-circle ${focusRingClass}`}
              type="button"
            >
              <MoreHorizontal aria-hidden="true" size={17} />
            </button>
          }
          items={moreItems}
        />
      ) : (
        <IconButton label="More canvas actions" size="sm" onClick={onMore}>
          <MoreHorizontal size={17} />
        </IconButton>
      )}
      <IconButton label="Copy link" size="sm" onClick={onLink}>
        <Link size={15} />
      </IconButton>
      <Pill aria-label="Share canvas" size="sm" variant="warm-outline" onClick={onShare}>
        Share <Share2 size={14} />
      </Pill>
    </div>
  );
}

export function Hero({ title, subtitle }: { title: [string, string]; subtitle: string }) {
  return (
    <div className="relative mx-auto flex w-full max-w-[560px] flex-col items-center text-center">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-[155px] w-[340px] -translate-x-1/2 overflow-visible"
        viewBox="0 0 340 155"
        fill="none"
      >
        <g
          stroke="var(--circuit-line)"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M170 78V22H104V8M170 78V40H234V15M170 78H70V60H40M170 78H270V58H302M170 78V126H126V144M170 78V110H222V138" />
          <path d="M170 78H124V52H90V32M170 78H216V48H254V34" />
        </g>
        <g fill="var(--bg-canvas)" stroke="var(--circuit-line)" strokeWidth="1.5">
          <circle cx="104" cy="8" r="2.5" />
          <circle cx="234" cy="15" r="2.5" />
          <circle cx="40" cy="60" r="2.5" />
          <circle cx="302" cy="58" r="2.5" />
          <circle cx="126" cy="144" r="2.5" />
          <circle cx="222" cy="138" r="2.5" />
        </g>
        <circle cx="40" cy="60" r="2.5" fill="var(--blue-500)" />
        <circle cx="302" cy="58" r="2.5" fill="var(--warn)" />
      </svg>
      <div className="relative mt-7 flex size-14 items-center justify-center rounded-[16px] bg-[var(--hero-tile)] shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
        <FerryMark size={32} variant="brand" />
      </div>
      <h1 className="mt-5 flex flex-col text-hero font-semibold leading-[38px]">
        <GradientText>{title[0]}</GradientText>
        <GradientText>{title[1]}</GradientText>
      </h1>
      <p className="mt-2 max-w-[440px] text-body leading-5 text-text-2">{subtitle}</p>
    </div>
  );
}

const langVar = {
  ts: '--lang-ts',
  js: '--lang-js',
  py: '--lang-py',
  go: '--lang-go',
  rust: '--lang-rust',
  other: '--lang-other',
} as const;
export interface ChatCardProps {
  language: keyof typeof langVar;
  title: string;
  snippet: string;
  date: string;
  status?: 'running' | 'awaiting_approval' | 'interrupted' | 'idle' | 'error';
  repo?: string;
  onClick?: () => void;
}
export function ChatCard({ language, title, snippet, date, status, repo, onClick }: ChatCardProps) {
  return (
    <Spotlight className="h-[104px] w-[200px] shrink-0 rounded-card">
      <button
        className={`group relative flex h-full w-full flex-col rounded-card border border-border-hair bg-card p-3 text-left transition hover:bg-raised ${focusRingClass}`}
        onClick={onClick}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-lg text-label font-bold ${language === 'ts' ? 'text-white' : 'text-[var(--text-on-send)]'}`}
            style={{ backgroundColor: `var(${langVar[language]})` }}
          >
            {language === 'other' ? (
              <Code2 aria-hidden="true" size={14} />
            ) : language === 'ts' ? (
              'TS'
            ) : language === 'py' ? (
              'Py'
            ) : language === 'go' ? (
              'Go'
            ) : language === 'rust' ? (
              'R'
            ) : (
              'JS'
            )}
          </span>
          {status && status !== 'idle' && (
            <span
              aria-label={status === 'awaiting_approval' ? 'Awaiting approval' : status}
              className={`size-1.5 shrink-0 rounded-full ${status === 'error' ? 'bg-danger' : status === 'awaiting_approval' || status === 'interrupted' ? 'bg-warn' : 'bg-blue-500'}`}
            />
          )}
          {repo && (
            <span className="ml-auto max-w-28 truncate rounded-full bg-raised px-1.5 py-0.5 text-meta font-medium text-text-2">
              {repo}
            </span>
          )}
        </span>
        <span className="mt-1 truncate text-[12.5px] leading-[18px] font-semibold text-text-1">
          {title}
        </span>
        <span className="truncate text-[11.5px] leading-4 text-text-2">{snippet}</span>
        <span className="mt-auto text-meta text-text-3">{date}</span>
      </button>
    </Spotlight>
  );
}
export function ContinueRow({ cards }: { cards: ChatCardProps[] }) {
  const list = useRef<HTMLDivElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      list.current?.scrollBy({ left: event.key === 'ArrowRight' ? 208 : -208, behavior: 'smooth' });
    }
  }
  return (
    <section className="mt-2 min-w-0" aria-label="Continue">
      <h2 className="mb-3 text-label font-medium text-text-2">Continue</h2>
      <div
        aria-label="Continue sessions"
        className="flex gap-3 overflow-x-auto pb-1"
        onKeyDown={onKeyDown}
        ref={list}
        role="region"
        tabIndex={0}
      >
        {cards.map((card) => (
          <ChatCard key={card.title} {...card} />
        ))}
      </div>
    </section>
  );
}
export function PinnedChatsRow({
  cards,
  onSeeAll,
}: {
  cards: ChatCardProps[];
  onSeeAll?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      list.current?.scrollBy({ left: event.key === 'ArrowRight' ? 208 : -208, behavior: 'smooth' });
    }
  }
  return (
    <section className="mt-6 min-w-0">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-label font-medium text-text-2">
          <Pin size={14} /> Pinned Chats <ChevronDown size={13} />
        </h2>
        <button
          className="text-label text-text-3 hover:text-text-1"
          onClick={onSeeAll}
          type="button"
        >
          See all ›
        </button>
      </header>
      <div className="relative after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-8 after:bg-gradient-to-l after:from-canvas after:to-transparent">
        <div
          aria-label="Pinned chats"
          className="flex gap-3 overflow-x-auto pb-1"
          onKeyDown={onKeyDown}
          ref={list}
          role="region"
          tabIndex={0}
        >
          {cards.map((card) => (
            <ChatCard key={card.title} {...card} />
          ))}
        </div>
      </div>
    </section>
  );
}

const suggestionItems = [
  ['Explain this repo', BookOpenText],
  ['Fix failing tests', FlaskConical],
  ['Write tests', TestTube],
  ['Refactor', Wand2],
  ['Review my changes', GitPullRequest],
  ['Plan a feature', Map],
] as const;
export function SuggestionChips({ onSelect }: { onSelect?: (value: string) => void }) {
  return (
    <div
      aria-label="Suggested prompts"
      className="relative mt-5 after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-6 after:bg-gradient-to-l after:from-canvas after:to-transparent"
    >
      <div className="flex gap-2 overflow-x-auto pb-1">
        {suggestionItems.map(([label, Icon]) => (
          <button
            className={`inline-flex h-[30px] shrink-0 items-center gap-2 rounded-pill border border-border-soft px-3 text-[12.5px] leading-4 text-[var(--chip-text)] hover:bg-icon-circle ${focusRingClass}`}
            key={label}
            onClick={() => onSelect?.(label)}
            type="button"
          >
            <Icon size={14} strokeWidth={1.75} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  banner?: { text: string; actionLabel: string; onAction: () => void } | null;
  profileName: string;
  onProfileClick?: () => void;
  profileMenuItems?: {
    label?: string;
    separator?: boolean;
    onSelect?: () => void;
  }[];
  profileControl?: ReactNode;
  workspaceName?: string;
  workspaceMenuItems?: { label: string; onSelect: () => void }[];
  onWorkspaceClick?: () => void;
  onAttach?: () => void;
  placeholder?: string;
  focusRequested?: boolean;
  onFocusRequestConsumed?: () => void;
}
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  banner,
  profileName,
  onProfileClick,
  profileMenuItems,
  profileControl,
  workspaceName,
  workspaceMenuItems,
  onWorkspaceClick,
  onAttach,
  placeholder = 'Ask Ferry to build, fix or explain…',
  focusRequested = false,
  onFocusRequestConsumed,
}: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focusRequested) return;
    let frame = 0;
    const startedAt = performance.now();
    const focusWhenReady = () => {
      const textarea = area.current;
      const modalOpen = document.querySelector('[role="dialog"][data-state="open"]');
      if (!modalOpen) textarea?.focus();
      if (textarea && document.activeElement === textarea) {
        onFocusRequestConsumed?.();
        return;
      }
      if (performance.now() - startedAt < 1000) {
        frame = window.requestAnimationFrame(focusWhenReady);
      }
    };
    frame = window.requestAnimationFrame(focusWhenReady);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusRequested, onFocusRequestConsumed]);
  function resize() {
    const el = area.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${String(Math.min(240, Math.max(44, el.scrollHeight)))}px`;
    }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (running) onStop();
      else if (value.trim()) onSend();
    }
  }
  return (
    <div className="v2-composer-wrap">
      {banner && (
        <div className="v2-composer-banner" role="status">
          <span>
            <Timer size={14} />
            {banner.text}
          </span>
          <button onClick={banner.onAction} type="button">
            {banner.actionLabel}
            <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      <div className="v2-composer">
        <div className="v2-composer-input-row">
          <Sparkles aria-hidden="true" />
          <textarea
            aria-label="Message Ferry"
            className="v2-composer-input border-0 shadow-none outline-none focus-visible:ring-0"
            onChange={(e) => {
              onChange(e.currentTarget.value);
              resize();
            }}
            onKeyDown={keyDown}
            placeholder={placeholder}
            ref={area}
            rows={1}
            value={value}
          />
        </div>
        <div className="v2-composer-toolbar">
          <div className="v2-composer-tools">
            <button
              className="v2-composer-tool"
              aria-label="Attach file"
              onClick={onAttach}
              type="button"
            >
              <Link aria-hidden="true" />
              Attach
            </button>
            {profileControl ??
              (profileMenuItems ? (
                <DropdownMenu
                  align="start"
                  clampHeight
                  trigger={
                    <button className="v2-composer-chip text-[14px]" type="button">
                      <Lightbulb aria-hidden="true" />
                      {profileName}
                      <ChevronDown aria-hidden="true" />
                    </button>
                  }
                  items={profileMenuItems}
                  side="top"
                />
              ) : (
                <button
                  className="v2-composer-chip text-[14px]"
                  onClick={onProfileClick}
                  type="button"
                >
                  <Lightbulb aria-hidden="true" />
                  {profileName}
                  <ChevronDown aria-hidden="true" />
                </button>
              ))}
            {workspaceName &&
              (workspaceMenuItems?.length ? (
                <DropdownMenu
                  align="start"
                  clampHeight
                  trigger={
                    <button className="v2-composer-tool" type="button">
                      <FolderOpen aria-hidden="true" />
                      {workspaceName}
                      <ChevronDown aria-hidden="true" />
                    </button>
                  }
                  items={workspaceMenuItems}
                  side="top"
                />
              ) : (
                <button className="v2-composer-tool" onClick={onWorkspaceClick} type="button">
                  <FolderOpen aria-hidden="true" />
                  {workspaceName}
                  <ChevronDown aria-hidden="true" />
                </button>
              ))}
          </div>
          <div className="v2-composer-send">
            {running ? (
              <button aria-label="Stop" className="v2-send-button" onClick={onStop} type="button">
                <Square aria-hidden="true" />
              </button>
            ) : (
              <button
                aria-label="Send"
                className="v2-send-button"
                disabled={!value.trim()}
                onClick={onSend}
                type="button"
              >
                <Send aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="v2-disclaimer">Ferry can make mistakes. Check changes before you use them.</p>
    </div>
  );
}
export function Disclaimer() {
  return (
    <p className="mt-3 text-center text-[10.5px] leading-[14px] text-text-3">
      Ferry uses AI models and can make mistakes. Review changes before committing.{' '}
      <a className="underline underline-offset-2 hover:text-text-2" href="#data-use">
        Data use
      </a>
    </p>
  );
}
