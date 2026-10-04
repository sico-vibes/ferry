import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  FolderOpen,
  Lightbulb,
  Link,
  Send,
  Square,
  Timer,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { DropdownMenu } from '../forms';

export function CanvasPanel({
  children,
  className,
  overflowContained = false,
}: {
  children?: ReactNode;
  className?: string;
  overflowContained?: boolean;
}) {
  return (
    <section
      data-audit-overflow={overflowContained ? 'intentional' : undefined}
      className={cn(
        'relative flex min-h-0 flex-col overflow-hidden rounded-card bg-background p-5',
        className,
      )}
    >
      <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col">{children}</div>
    </section>
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
            {onAttach && (
              <button
                className="v2-composer-tool"
                aria-label="Attach file"
                onClick={onAttach}
                type="button"
              >
                <Link aria-hidden="true" />
                Attach
              </button>
            )}
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
