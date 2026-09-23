import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { MessageCircle, MoreHorizontal, PanelRight, Search, Share2, Star } from 'lucide-react';
import { IconButton, KbdChip, NewChatButton } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { keys, useSessions } from '../../data/queries';
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
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const { data: sessions = [] } = useSessions(search);
  const openTab = useUI((state) => state.openTab);
  const toggleRight = useUI((state) => state.toggleRight);
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
              <span className="chat-title">{session.title}</span>
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
      <div className="right-panel-scroll">
        {section('Saved topics', saved, true)}
        <div className="blue-separator" />
        {section('Recent chats', recent, false)}
        {sessions.length === 0 && <p className="empty-search">No chats match that search.</p>}
      </div>
    </aside>
  );
}
