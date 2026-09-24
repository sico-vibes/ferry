import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowUpRight,
  AudioLines,
  BookOpenText,
  ChevronDown,
  FlaskConical,
  GitPullRequest,
  Lightbulb,
  Link,
  Map,
  MoreHorizontal,
  Pin,
  Send,
  Share2,
  Square,
  Timer,
  TestTube,
  Wand2,
} from 'lucide-react';
import { AmbientGlow } from '../../effects/AmbientGlow';
import { DotGrid } from '../../effects/DotGrid';
import { GradientBorder } from '../../effects/GradientBorder';
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
}: {
  onMore?: () => void;
  onLink?: () => void;
  onShare?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <IconButton label="More canvas actions" size="sm" onClick={onMore}>
        <MoreHorizontal size={17} />
      </IconButton>
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
  status?: 'running' | 'awaiting_approval' | 'idle' | 'error';
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
            className={`flex size-6 shrink-0 items-center justify-center rounded-lg text-label font-bold ${language === 'ts' ? 'text-white' : 'text-[var(--text-on-send)]'}`}
            style={{ backgroundColor: `var(${langVar[language]})` }}
          >
            {language === 'ts'
              ? 'TS'
              : language === 'py'
                ? 'Py'
                : language === 'go'
                  ? 'Go'
                  : language === 'rust'
                    ? 'R'
                    : language.toUpperCase()}
          </span>
          {status && status !== 'idle' && (
            <span
              aria-label={status === 'awaiting_approval' ? 'Awaiting approval' : status}
              className={`size-1.5 shrink-0 rounded-full ${status === 'error' ? 'bg-danger' : status === 'awaiting_approval' ? 'bg-warn' : 'bg-blue-500'}`}
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
  onAttach?: () => void;
  placeholder?: string;
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
  onAttach,
  placeholder = 'Ask Ferry to build, fix or explain…',
}: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
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
  const topBand = {
    height: banner ? 30 : 3,
    content: banner ? (
      <div className="flex h-full items-center justify-between gap-3 px-3 text-label font-medium text-white/90 composer-banner-content">
        <span className="flex min-w-0 items-center gap-2 truncate">
          <Timer size={14} />
          {banner.text}
        </span>
        <button
          className="flex shrink-0 items-center gap-1 font-semibold text-warn hover:brightness-125"
          onClick={banner.onAction}
          type="button"
        >
          {banner.actionLabel}
          <ArrowUpRight size={14} />
        </button>
      </div>
    ) : null,
  };
  return (
    <div className="mt-auto pt-5">
      <GradientBorder
        className="w-full"
        gradient="composer"
        width={3}
        radius="panel"
        shimmer
        topBand={topBand}
      >
        <div className="flex min-h-[148px] flex-col rounded-[14px] bg-input p-3">
          <textarea
            aria-label="Message Ferry"
            data-audit-spacing="intentional"
            className="min-h-11 max-h-60 w-full resize-none bg-transparent px-0.5 py-0.5 text-body text-text-1 placeholder:text-text-3 focus:outline-none"
            onChange={(e) => {
              onChange(e.currentTarget.value);
              resize();
            }}
            onKeyDown={keyDown}
            placeholder={placeholder}
            ref={area}
            rows={2}
            value={value}
          />
          <div className="mt-auto flex items-center justify-between gap-2 pt-3">
            <div className="flex gap-2">
              <Pill
                className="h-7 px-3 text-[12px] leading-4 font-medium"
                leadingIcon={<Link size={14} />}
                onClick={onAttach}
              >
                Attach
              </Pill>
              {profileMenuItems ? (
                <DropdownMenu
                  trigger={
                    <Pill
                      className="h-7 border-transparent bg-blue-tint px-3 text-[12px] leading-4 font-medium text-link"
                      leadingIcon={<Lightbulb size={14} />}
                    >
                      {profileName}
                    </Pill>
                  }
                  items={profileMenuItems}
                />
              ) : (
                <Pill
                  className="h-7 border-transparent bg-blue-tint px-3 text-[12px] leading-4 font-medium text-link"
                  onClick={onProfileClick}
                  leadingIcon={<Lightbulb size={14} />}
                >
                  {profileName}
                </Pill>
              )}
            </div>
            <div className="flex gap-2">
              <span title="Voice input is coming soon">
                <Pill
                  className="h-7 px-3 text-[12px] leading-4 font-medium"
                  disabled
                  leadingIcon={<AudioLines size={14} />}
                >
                  Voice
                </Pill>
              </span>
              {running ? (
                <Pill
                  className="h-[30px] px-3 text-[12.5px] leading-4 font-semibold"
                  onClick={onStop}
                >
                  <Square size={14} fill="currentColor" />
                  Stop
                </Pill>
              ) : (
                <Pill
                  className="h-[30px] border-transparent bg-[image:var(--grad-send)] px-3 text-[12.5px] leading-4 font-semibold text-[var(--text-on-send)] disabled:opacity-60 disabled:saturate-[0.8]"
                  disabled={!value.trim()}
                  onClick={onSend}
                  trailingIcon={<Send size={14} />}
                >
                  Send
                </Pill>
              )}
            </div>
          </div>
        </div>
      </GradientBorder>
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
