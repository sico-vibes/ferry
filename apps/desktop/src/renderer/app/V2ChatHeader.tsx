import { useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, PanelRight, Share2, Trash2 } from 'lucide-react';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useSessions } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import type { SessionId } from '@ferry/shared';
import { ApprovalsTray } from './SessionPowerControls';

const { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input } =
  UiV2;

export function V2ChatHeader() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const sessionId = pathname.startsWith('/s/')
    ? (pathname.slice(3).split('/')[0] as SessionId)
    : null;
  const tabs = useUI((state) => state.tabs);
  const { data: sessionRows = [] } = useSessions();
  const pushToast = useToasts((state) => state.push);
  const isSession = Boolean(sessionId);
  const tab = sessionId ? tabs.find((item) => item.id === sessionId) : undefined;
  const session = sessionId ? sessionRows.find((item) => item.id === sessionId) : undefined;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session?.title ?? 'New chat');
  const toggleRight = useUI((state) => state.toggleRight);
  const rightCollapsed = useUI((state) => state.rightCollapsed);
  const rename = async () => {
    const next = title.trim();
    if (!next || !sessionId) return;
    await client.sessions.rename(sessionId, next);
    useUI.getState().renameTab(sessionId, next);
    await cache.invalidateQueries({ queryKey: keys.sessions });
    setEditing(false);
  };
  const remove = async () => {
    if (!sessionId) return;
    await client.sessions.remove(sessionId);
    await cache.invalidateQueries({ queryKey: keys.sessions });
    await navigate({ to: '/' });
  };
  return (
    <header className="v2-chat-header">
      <div className="v2-header-title">
        {editing ? (
          <Input
            autoFocus
            aria-label="Session title"
            value={title}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
            onBlur={() => {
              void rename();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename();
              if (event.key === 'Escape') setEditing(false);
            }}
          />
        ) : isSession ? (
          <button
            className="v2-title-button"
            onClick={() => {
              setTitle(session?.title ?? tab?.title ?? 'New chat');
              setEditing(true);
            }}
            aria-label="Rename session"
          >
            {session?.title ?? tab?.title ?? 'Session'}
          </button>
        ) : null}
      </div>
      <div className="v2-header-actions">
        {isSession && <ApprovalsTray activeSessionId={sessionId} />}
        {isSession && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(window.location.href);
              pushToast({ kind: 'success', title: 'Link copied', body: null });
            }}
          >
            <Share2 aria-hidden="true" />
            Share
          </Button>
        )}
        {isSession && (
          <Button
            aria-label="Toggle drawer"
            aria-expanded={!rightCollapsed}
            variant="ghost"
            size="icon"
            onClick={toggleRight}
          >
            <PanelRight aria-hidden="true" />
          </Button>
        )}
        {isSession && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label="More session actions" variant="ghost" size="icon">
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-destructive" onSelect={() => void remove()}>
                <Trash2 />
                Delete session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  );
}
