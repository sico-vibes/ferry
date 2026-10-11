import { useEffect, useRef, type CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Terminal as XTerm } from '@xterm/xterm';
import type { SessionId } from '@ferry/shared';
import { FitAddon } from '@xterm/addon-fit';
import { useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Terminal, X } from 'lucide-react';
import { SegmentedControl, Skeleton } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useUI } from '../state/ui';

export function mockShellOutput(command: string): string {
  const normalized = command.trim().toLowerCase();
  if (normalized === 'git status')
    return 'On branch main\nYour branch is up to date with origin/main.\n\nnothing to commit, working tree clean';
  if (normalized === 'pnpm test')
    return 'PASS src/demo.test.ts\nTests: 1 passed, 1 total\n(demo output)';
  if (normalized === 'ls' || normalized === 'dir')
    return 'AGENTS.md  apps  docs  packages  pnpm-workspace.yaml';
  if (normalized === 'help') return 'Available commands: git status, pnpm test, ls, dir, help';
  return 'mock shell: command not available in demo';
}

function TerminalView() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.ferryHost) return;
    if (!host.current) return;
    const styles = getComputedStyle(document.documentElement);
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: styles.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 12,
      theme: {
        background: styles.getPropertyValue('--background').trim(),
        foreground: styles.getPropertyValue('--foreground').trim(),
        blue: styles.getPropertyValue('--accent-foreground').trim(),
        cursor: styles.getPropertyValue('--accent-foreground').trim(),
        selectionBackground: styles.getPropertyValue('--muted').trim(),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    const prompt = '\x1b[34mPS C:\\dev\\ferry-web>\x1b[0m ';
    term.write(prompt);
    let current = '';
    const input = term.onData((data) => {
      if (data === '\r') {
        term.write('\r\n');
        if (current.trim()) term.write(`${mockShellOutput(current).replaceAll('\n', '\r\n')}\r\n`);
        current = '';
        term.write(prompt);
      } else if (data === '\u007f') {
        if (current.length) {
          current = current.slice(0, -1);
          term.write('\b \b');
        }
      } else if (data.length === 1 && /^[\x20-\x7e]$/.test(data)) {
        current += data;
        term.write(data);
      }
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      input.dispose();
      term.dispose();
    };
  }, []);
  return window.ferryHost ? (
    <div className="grid gap-3 p-5" role="status">
      <strong>Terminal unavailable</strong>
      <p className="muted">
        This session has no connected terminal. Open Agent log to see commands Ferry executed.
      </p>
    </div>
  ) : (
    <div className="grid gap-2">
      <p className="muted" role="status">
        Connected to demo terminal. Commands use local fixtures.
      </p>
      <div aria-label="Terminal" className="terminal-host" ref={host} />
    </div>
  );
}

export function BottomPanel({ sessionId: activeSessionId }: { sessionId?: SessionId } = {}) {
  const client = useFerryClient();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const sessionId =
    activeSessionId ?? (path.startsWith('/s/') ? (path.slice(3) as SessionId) : null);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => (sessionId ? client.sessions.get(sessionId as never) : Promise.resolve(null)),
    enabled: Boolean(sessionId),
  });
  const bottomTab = useUI((s) => s.bottomTab);
  const bottomHeight = useUI((s) => s.bottomHeight);
  const setBottomTab = useUI((s) => s.setBottomTab);
  const toggleBottom = useUI((s) => s.toggleBottom);
  const isDrawer = activeSessionId !== undefined;
  const agentLogRows =
    data?.messages.flatMap((message) =>
      message.parts
        .filter((part) => part.type === 'tool_call')
        .map((part) => ({
          id: part.id,
          at: message.createdAt,
          title: part.title,
          status: part.status,
        })),
    ) ?? [];
  return (
    <section
      aria-label={isDrawer ? 'Session tools' : 'Bottom panel'}
      className="bottom-panel"
      style={{ '--bottom-height': `${String(bottomHeight)}px` } as CSSProperties}
    >
      <div
        aria-label="Resize bottom panel"
        aria-orientation="horizontal"
        aria-valuemin={200}
        aria-valuemax={480}
        aria-valuenow={bottomHeight}
        className="bottom-resize"
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const state = useUI.getState();
            state.setBottomHeight(
              Math.min(
                480,
                Math.max(200, state.bottomHeight + (event.key === 'ArrowUp' ? 10 : -10)),
              ),
            );
          }
        }}
        onPointerDown={(event) => {
          const start = event.clientY;
          const initial = useUI.getState().bottomHeight;
          const move = (next: PointerEvent) => {
            useUI.getState().setBottomHeight(initial + start - next.clientY);
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up, { once: true });
        }}
        role="separator"
        tabIndex={0}
      />
      {isDrawer ? (
        <div className="drawer-terminal-switch">
          <SegmentedControl
            label="Terminal view"
            value={bottomTab}
            onValueChange={(value) => {
              setBottomTab(value === 'terminal' ? 'terminal' : 'agent-log');
            }}
            options={[
              { value: 'terminal', label: 'Terminal' },
              { value: 'agent-log', label: 'Agent log' },
            ]}
          />
        </div>
      ) : (
        <header className="bottom-panel-header">
          <nav aria-label="Bottom panel tabs">
            <button
              aria-current={bottomTab === 'terminal' ? 'page' : undefined}
              onClick={() => {
                setBottomTab('terminal');
              }}
            >
              <Terminal size={14} /> Terminal
            </button>
            <button
              aria-current={bottomTab === 'agent-log' ? 'page' : undefined}
              onClick={() => {
                setBottomTab('agent-log');
              }}
            >
              Agent log
            </button>
          </nav>
          <button aria-label="Close bottom panel" className="header-icon" onClick={toggleBottom}>
            <X size={15} />
          </button>
        </header>
      )}
      {bottomTab === 'terminal' ? (
        <TerminalView />
      ) : (
        <div aria-label="Agent log" className="agent-log" role="region">
          {isError ? (
            <p role="alert">
              Agent log unavailable. <button onClick={() => void refetch()}>Retry</button>
            </p>
          ) : isLoading ? (
            <Skeleton rows={5} />
          ) : agentLogRows.length ? (
            agentLogRows.map((row) => (
              <div className="agent-log-row" key={row.id}>
                <time>{new Date(row.at).toLocaleTimeString()}</time>
                <span>{row.title}</span>
                <code>{row.status}</code>
              </div>
            ))
          ) : (
            <p className="muted">
              {sessionId
                ? 'Connected. Tool calls from this session will appear here.'
                : 'Open a session to see its agent log.'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
