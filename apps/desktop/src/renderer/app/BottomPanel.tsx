import { useEffect, useRef, type CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Terminal, X } from 'lucide-react';
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
    if (!host.current) return;
    const styles = getComputedStyle(document.documentElement);
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      theme: {
        background: styles.getPropertyValue('--bg-input').trim(),
        foreground: styles.getPropertyValue('--text-1').trim(),
        cursor: styles.getPropertyValue('--blue-500').trim(),
        selectionBackground: styles.getPropertyValue('--bg-raised').trim(),
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
  return <div aria-label="Terminal" className="terminal-host" ref={host} />;
}

export function BottomPanel() {
  const client = useFerryClient();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const sessionId = path.startsWith('/s/') ? path.slice(3) : null;
  const { data } = useQuery({
    queryKey: ['session', sessionId, 'agent-log'],
    queryFn: () => (sessionId ? client.sessions.get(sessionId as never) : Promise.resolve(null)),
    enabled: Boolean(sessionId),
    refetchInterval: 1500,
  });
  const bottomTab = useUI((s) => s.bottomTab);
  const bottomHeight = useUI((s) => s.bottomHeight);
  const setBottomTab = useUI((s) => s.setBottomTab);
  const toggleBottom = useUI((s) => s.toggleBottom);
  return (
    <section
      aria-label="Bottom panel"
      className="bottom-panel"
      style={{ '--bottom-height': `${String(bottomHeight)}px` } as CSSProperties}
    >
      <div
        aria-label="Resize bottom panel"
        className="bottom-resize"
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const state = useUI.getState();
            state.setBottomHeight(state.bottomHeight + (event.key === 'ArrowUp' ? 10 : -10));
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
      {bottomTab === 'terminal' ? (
        <TerminalView />
      ) : (
        <div aria-label="Agent log" className="agent-log">
          {data?.messages.flatMap((message) =>
            message.parts
              .filter((part) => part.type === 'tool_call')
              .map((part) => (
                <div className="agent-log-row" key={part.id}>
                  <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                  <span>{part.title}</span>
                  <code>{part.status}</code>
                </div>
              )),
          ) ?? <p className="muted">Tool calls from this session will appear here.</p>}
        </div>
      )}
    </section>
  );
}
