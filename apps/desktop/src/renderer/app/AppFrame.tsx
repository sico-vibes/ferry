import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { FileText } from 'lucide-react';
import { TabsBar, Toaster, TopRightCluster } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys, useSessions } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { Sidebar } from './Sidebar';
import { RightPanel } from './right-panel/RightPanel';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useFerryEvents();
  const { data: sessions = [] } = useSessions();
  const tabs = useUI((state) => state.tabs);
  const activeId = useUI((state) => state.activeId);
  const leftCollapsed = useUI((state) => state.leftCollapsed);
  const rightCollapsed = useUI((state) => state.rightCollapsed);
  const openTab = useUI((state) => state.openTab);
  const setActive = useUI((state) => state.setActive);
  const closeTab = useUI((state) => state.closeTab);
  const pushToast = useToasts((state) => state.push);
  const toastItems = useToasts((state) => state.items);
  const dismissToast = useToasts((state) => state.dismiss);
  const labels = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );
  const activeNav = pathname.startsWith('/explore')
    ? 'explore'
    : pathname === '/library'
      ? 'library'
      : 'chats';
  const createChat = async () => {
    const workspaces = await client.workspaces.list();
    const workspace = workspaces[0];
    if (!workspace) {
      pushToast({
        kind: 'warning',
        title: 'Add a folder first',
        body: 'Choose a workspace before starting a chat.',
      });
      return;
    }
    const session = await client.sessions.create({ workspaceId: workspace.id });
    openTab({ id: session.id, title: session.title });
    await cache.invalidateQueries({ queryKey: keys.sessions });
    await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        void createChat();
      } else if (key === 'b' && event.shiftKey) {
        event.preventDefault();
        useUI.getState().toggleRight();
      } else if (key === 'b') {
        event.preventDefault();
        useUI.getState().toggleLeft();
      } else if (key === 'f') {
        event.preventDefault();
        if (useUI.getState().rightCollapsed) useUI.getState().toggleRight();
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>('[aria-label="Search chats"]')?.focus(),
        );
      } else if (key === 'w' && activeId) {
        event.preventDefault();
        closeTab(activeId);
      } else if (key === 'tab' && tabs.length > 1) {
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.id === activeId);
        const next = tabs[(index + 1) % tabs.length];
        if (next) {
          setActive(next.id);
          void navigate({ to: '/s/$sessionId', params: { sessionId: next.id } });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [activeId, cache, closeTab, createChat, navigate, openTab, pushToast, setActive, tabs]);

  useEffect(() => {
    const timers = toastItems.map((toast) =>
      window.setTimeout(() => {
        dismissToast(toast.id);
      }, 5000),
    );
    return () => {
      timers.forEach((timer) => {
        window.clearTimeout(timer);
      });
    };
  }, [toastItems, dismissToast]);

  const tabItems = tabs.map((tab) => ({
    id: tab.id,
    label: labels.get(tab.id) ?? tab.title,
    icon: FileText,
  }));
  const currentId = pathname.startsWith('/s/') ? pathname.slice('/s/'.length) : (activeId ?? '');
  return (
    <div
      className={`app-shell ${leftCollapsed ? 'left-is-collapsed' : ''} ${rightCollapsed ? 'right-is-collapsed' : ''}`}
    >
      <div className="title-strip" aria-hidden="true" />
      <div className="app-grid">
        <Sidebar activeNav={activeNav} />
        <main className="center-column">
          <TabsBar
            tabs={tabItems}
            activeId={currentId}
            onSelect={(id) => {
              setActive(id as (typeof tabs)[number]['id']);
              void navigate({ to: '/s/$sessionId', params: { sessionId: id } });
            }}
            onClose={(id) => {
              closeTab(id as (typeof tabs)[number]['id']);
            }}
            onAdd={() => void createChat()}
            rightCluster={
              <TopRightCluster
                onConfiguration={() => {
                  pushToast({
                    kind: 'info',
                    title: 'Configuration',
                    body: 'Configuration controls arrive in a later update.',
                  });
                }}
                onShare={() => {
                  pushToast({
                    kind: 'success',
                    title: 'Share',
                    body: 'There is nothing to share yet.',
                  });
                }}
              />
            }
          />
          <div className="canvas-slot">{children}</div>
        </main>
        {!rightCollapsed && <RightPanel onNewChat={() => void createChat()} />}
      </div>
      <Toaster
        messages={toastItems.map((toast) => ({
          id: String(toast.id),
          kind: toast.kind,
          text: toast.body ? `${toast.title}: ${toast.body}` : toast.title,
        }))}
      />
    </div>
  );
}
