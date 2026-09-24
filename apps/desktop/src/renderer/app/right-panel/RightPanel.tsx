import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Check,
  FileCode2,
  ListChecks,
  MessageCircle,
  MoreHorizontal,
  PanelRight,
  Search,
  Share2,
  Star,
} from 'lucide-react';
import { EmptyState, IconButton, KbdChip, NewChatButton, Skeleton } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { keys, useSessionDetail, useSessions } from '../../data/queries';
import { useUI } from '../../state/ui';

export function editedAt(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const delta = date.getTime() - now;
  if (Math.abs(delta) > 7 * 86_400_000)
    return `Edited ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)}`;
  const [unit, length] =
    Math.abs(delta) < 3_600_000
      ? (['minute', 60_000] as const)
      : Math.abs(delta) < 172_800_000
        ? (['hour', 3_600_000] as const)
        : (['day', 86_400_000] as const);
  const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
  return `Edited ${relative.format(Math.round(delta / length), unit)}`;
}

export function RightPanel({ onNewChat }: { onNewChat: () => void }) {
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions(search);
  const openTab = useUI((state) => state.openTab);
  const toggleRight = useUI((state) => state.toggleRight);
  const rightTab = useUI((state) => state.rightTab);
  const rightWidth = useUI((state) => state.rightWidth);
  const setRightWidth = useUI((state) => state.setRightWidth);
  const setRightTab = useUI((state) => state.setRightTab);
  const activeId = useUI((state) => state.activeId);
  const scrollKey = `${activeId ?? 'none'}:${rightTab}`;
  const { data: activeSession } = useSessionDetail(activeId ?? ('' as never));
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = scrollPositions.current.get(scrollKey) ?? 0;
  }, [scrollKey]);
  const setStar = useMutation({
    mutationFn: ({ id, starred }: { id: (typeof sessions)[number]['id']; starred: boolean }) =>
      client.sessions.setStarred(id, starred),
    onSuccess: () => cache.invalidateQueries({ queryKey: keys.sessions }),
  });
  const saved = useMemo(() => sessions.filter((session) => session.starred), [sessions]);
  const recent = useMemo(() => sessions.filter((session) => !session.starred), [sessions]);
  function goToSession(session: (typeof sessions)[number]): void {
    openTab({ id: session.id, title: session.title });
    void navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
  }
  const section = (title: string, items: typeof sessions, isSaved: boolean) => (
    <section className="chat-section">
      <header className="right-section-heading">
        <span className="section-label">
          {isSaved ? <Star size={14} /> : <MessageCircle size={14} />}
          {title}
        </span>
        <button aria-label={`More ${title}`} className="header-icon">
          <MoreHorizontal size={16} />
        </button>
      </header>
      <div>
        {items.map((session) => (
          <div className="chat-row" key={session.id}>
            <button
              className="chat-row-main"
              onClick={() => {
                goToSession(session);
              }}
            >
              <span className="chat-title">
                {(session.status === 'running' || session.status === 'awaiting_approval') && (
                  <span className="session-status-dot" aria-label={session.status} />
                )}
                {session.title}
              </span>
              <span className="chat-meta">{editedAt(session.updatedAt)}</span>
            </button>
            <button
              aria-label={`${session.starred ? 'Unsave' : 'Save'} ${session.title}`}
              className={`row-star ${session.starred ? 'is-starred' : ''}`}
              onClick={() => {
                setStar.mutate({ id: session.id, starred: !session.starred });
              }}
            >
              <Star size={16} fill={session.starred ? 'currentColor' : 'none'} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
  return (
    <aside className="right-panel">
      <span className="right-edge-glow" />
      <button
        aria-label="Resize right panel"
        aria-orientation="vertical"
        aria-valuemin={300}
        aria-valuemax={560}
        aria-valuenow={rightWidth}
        className="right-resize-handle"
        onDoubleClick={() => {
          setRightWidth(300);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setRightWidth(
            Math.min(
              560,
              Math.max(300, useUI.getState().rightWidth + (event.key === 'ArrowLeft' ? 10 : -10)),
            ),
          );
        }}
        onPointerDown={(event) => {
          const start = event.clientX;
          const initial = useUI.getState().rightWidth;
          const move = (next: PointerEvent) => {
            useUI.getState().setRightWidth(initial + start - next.clientX);
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
        title="Drag to resize. Double-click to reset."
        type="button"
      />
      <header className="right-panel-header">
        <IconButton label="Collapse right panel" size="sm" onClick={toggleRight}>
          <PanelRight size={16} />
        </IconButton>
        <IconButton label="Share" size="sm">
          <Share2 size={16} />
        </IconButton>
        <IconButton label="More options" size="sm">
          <MoreHorizontal size={17} />
        </IconButton>
        <NewChatButton size="sm" className="ml-auto" onClick={onNewChat}>
          New Chat
        </NewChatButton>
      </header>
      <label className="chat-search">
        <Search size={16} />
        <input
          aria-label="Search chats"
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          placeholder="Search chats…"
          ref={input}
          value={search}
        />
        <KbdChip>Ctrl F</KbdChip>
      </label>
      <nav aria-label="Right panel tabs" className="right-tabs">
        {(['chats', 'plan', 'changes'] as const).map((tab) => (
          <button
            aria-current={rightTab === tab ? 'page' : undefined}
            className={rightTab === tab ? 'right-tab active' : 'right-tab'}
            key={tab}
            onClick={() => {
              if (scroll.current) {
                scrollPositions.current.set(
                  `${activeId ?? 'none'}:${rightTab}`,
                  scroll.current.scrollTop,
                );
              }
              setRightTab(tab);
            }}
            type="button"
          >
            {tab === 'chats' ? 'Chats' : tab === 'plan' ? 'Plan' : 'Changes'}
          </button>
        ))}
      </nav>
      <div
        className="right-panel-scroll"
        ref={scroll}
        onScroll={(event) => {
          scrollPositions.current.set(scrollKey, event.currentTarget.scrollTop);
        }}
      >
        {rightTab === 'chats' &&
          (sessionsLoading ? (
            <Skeleton rows={6} />
          ) : (
            <>
              {section('Saved topics', saved, true)}
              <div className="blue-separator" />
              {section('Recent chats', recent, false)}
              {sessions.length === 0 && (
                <EmptyState
                  title={search ? 'No chats match that search.' : 'No sessions yet'}
                  action={search ? 'Clear search' : 'Start a chat'}
                  onAction={() => {
                    if (search) setSearch('');
                    else onNewChat();
                  }}
                />
              )}
            </>
          ))}
        {rightTab === 'plan' && (
          <section className="task-panel">
            <h2>
              <ListChecks size={14} /> Plan
            </h2>
            {activeSession?.taskRecord ? (
              <>
                <p className="task-goal">{activeSession.taskRecord.goal}</p>
                <ol>
                  {activeSession.taskRecord.plan.map((item) => (
                    <li key={item.id} className={`task-item task-${item.status}`}>
                      <span>
                        {item.status === 'done' ? (
                          <Check size={13} />
                        ) : item.status === 'doing' ? (
                          '◉'
                        ) : (
                          '○'
                        )}
                      </span>
                      {item.text}
                    </li>
                  ))}
                </ol>
                {!!activeSession.taskRecord.decisions.length && (
                  <>
                    <h3>Decisions</h3>
                    {activeSession.taskRecord.decisions.map((item) => (
                      <p className="task-detail" key={item.text}>
                        {item.text}
                        <small>{item.why}</small>
                      </p>
                    ))}
                  </>
                )}
                {!!activeSession.taskRecord.touchedFiles.length && (
                  <>
                    <h3>Touched files</h3>
                    {activeSession.taskRecord.touchedFiles.map((item) => (
                      <p className="task-detail" key={item.path}>
                        <code>{item.path}</code>
                        <small>{item.purpose}</small>
                      </p>
                    ))}
                  </>
                )}
                {activeSession.taskRecord.nextStep && (
                  <p className="task-next">
                    <b>Next</b>
                    {activeSession.taskRecord.nextStep}
                  </p>
                )}
              </>
            ) : (
              <p className="empty-search">Open a session to see its live plan.</p>
            )}
          </section>
        )}
        {rightTab === 'changes' && <ChangesPanel detail={activeSession} />}
      </div>
    </aside>
  );
}

function ChangesPanel({ detail }: { detail: ReturnType<typeof useSessionDetail>['data'] }) {
  const [selected, setSelected] = useState<{
    path: string;
    before: string | null;
    after: string | null;
  } | null>(null);
  const client = useFerryClient();
  const navigate = useNavigate();
  const { data: runs = [] } = useQuery({
    queryKey: ['delegation', detail?.session.id],
    queryFn: () => (detail ? client.delegation.runs(detail.session.id) : Promise.resolve([])),
    enabled: Boolean(detail?.session.id),
  });
  const changes =
    detail?.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'tool_call' ? part.changes : [])),
    ) ?? [];
  const delegated = runs.flatMap((run) =>
    run.touchedFiles.map((file) => ({
      path: file.path,
      status: 'modified' as const,
      additions: 0,
      deletions: 0,
      before: null,
      after: null,
    })),
  );
  const unique = [
    ...new Map([...changes, ...delegated].map((change) => [change.path, change])).values(),
  ];
  const reviewRun = runs.find((run) => run.touchedFiles.length > 0);
  return (
    <section className="task-panel">
      <h2>
        <FileCode2 size={14} /> Changes <span>{unique.length}</span>
      </h2>
      {reviewRun && detail && (
        <button
          className="change-row"
          onClick={() =>
            void navigate({
              to: '/s/$sessionId/review/$runId',
              params: { sessionId: detail.session.id, runId: reviewRun.id },
            })
          }
          type="button"
        >
          Open review <span>{reviewRun.lane}</span>
        </button>
      )}
      {unique.length ? (
        unique.map((change) => (
          <button
            className="change-row"
            key={change.path}
            onClick={() => {
              setSelected(change);
            }}
          >
            <code>{change.path}</code>
            <span className="text-success">+{change.additions}</span>
            <span className="text-danger">−{change.deletions}</span>
          </button>
        ))
      ) : (
        <p className="empty-search">No changed files yet.</p>
      )}
      {selected && (
        <div className="diff-view">
          <header>
            <strong>{selected.path}</strong>
            <button
              onClick={() => {
                setSelected(null);
              }}
            >
              Close
            </button>
          </header>
          <div>
            <pre>{selected.before ?? 'New file'}</pre>
            <pre>{selected.after ?? 'File removed'}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
