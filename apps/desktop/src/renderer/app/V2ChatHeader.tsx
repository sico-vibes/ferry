import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Share2,
  Trash2,
} from 'lucide-react';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useSessions, useWorkspaces } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import type { SessionId } from '@ferry/shared';
import { ApprovalsTray } from './SessionPowerControls';
import { ConfirmDialog } from './ConfirmDialog';

const { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input } =
  UiV2;

export function V2ChatHeader({
  children,
  onboardingMode = false,
}: {
  children?: ReactNode;
  onboardingMode?: boolean;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const sessionId = pathname.startsWith('/s/')
    ? (pathname.slice(3).split('/')[0] as SessionId)
    : null;
  const tabs = useUI((state) => state.tabs);
  const { data: sessionRows = [] } = useSessions();
  const { data: workspaces = [] } = useWorkspaces();
  const pushToast = useToasts((state) => state.push);
  const isSession = Boolean(sessionId);
  const tab = sessionId ? tabs.find((item) => item.id === sessionId) : undefined;
  const session = sessionId ? sessionRows.find((item) => item.id === sessionId) : undefined;
  const selectedWorkspaceId = useUI((state) => state.selectedWorkspaceId);
  const workspaceId = session?.workspaceId ?? selectedWorkspaceId;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState(session?.title ?? 'New chat');
  const toggleRight = useUI((state) => state.toggleRight);
  const rightCollapsed = useUI((state) => state.rightCollapsed);
  const leftCollapsed = useUI((state) => state.leftCollapsed);
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
  const contextTitle = isSession
    ? (session?.title ?? tab?.title ?? 'New chat')
    : onboardingMode
      ? 'Setup'
      : pathname.startsWith('/settings')
        ? 'Settings'
        : pathname.startsWith('/library')
          ? 'Library'
          : pathname.startsWith('/models')
            ? 'Models'
            : pathname.startsWith('/gateway')
              ? 'Gateway'
              : 'New chat';
  return (
    <>
      <header className="title-strip v2-titlebar v2-chat-header" aria-label="Window title bar">
        <div className="v2-titlebar-navigation">
          {!onboardingMode && (
            <Button
              aria-label={leftCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!leftCollapsed}
              variant="ghost"
              size="icon"
              onClick={() => {
                useUI.getState().toggleLeft();
              }}
            >
              <PanelLeft aria-hidden="true" />
            </Button>
          )}
          <Button
            aria-label="Go back"
            variant="ghost"
            size="icon"
            onClick={() => {
              window.history.back();
            }}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <Button
            aria-label="Go forward"
            variant="ghost"
            size="icon"
            onClick={() => {
              window.history.forward();
            }}
          >
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
        <div className="v2-titlebar-context v2-header-title">
          <span className="v2-titlebar-project">{workspace?.name ?? 'Ferry'}</span>
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
          ) : (
            <span className="v2-titlebar-page-title">{contextTitle}</span>
          )}
        </div>
        <div className="v2-header-actions">
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
          {isSession && <ApprovalsTray activeSessionId={sessionId} />}
          {isSession && (
            <Button
              aria-label="Toggle drawer"
              aria-expanded={!rightCollapsed}
              variant="ghost"
              size="icon"
              onClick={() => {
                toggleRight();
              }}
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
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() => {
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 />
                  Delete session
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {children}
        <WebPreviewWindowControls />
      </header>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete chat?"
        description="This permanently removes the chat from Ferry."
        confirmLabel="Delete chat"
        destructive
        onConfirm={() => {
          void remove();
        }}
      />
    </>
  );
}

function WebPreviewWindowControls() {
  if (!(
    import.meta.env.DEV &&
    (new URLSearchParams(location.search).get('preview') === 'web' || location.port === '5199')
  ))
    return null;
  return (
    <div className="web-preview-window-controls" aria-label="Window controls">
      <button aria-label="Minimize" type="button">
        <span className="web-preview-control-glyph web-preview-minimize-glyph" />
      </button>
      <button aria-label="Maximize" type="button">
        <span className="web-preview-control-glyph web-preview-maximize-glyph" />
      </button>
      <button aria-label="Close" type="button">
        <span className="web-preview-control-glyph web-preview-close-glyph">&#x2715;</span>
      </button>
    </div>
  );
}
