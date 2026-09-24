import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { FileText, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { TabsBar, TopRightCluster } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys, useSessions, useSettings } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { Sidebar } from './Sidebar';
import { RightPanel } from './right-panel/RightPanel';
import { appMounts } from './mounts';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useFerryEvents();
  const { data: sessions = [] } = useSessions();
  const { data: settings } = useSettings();
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const theme =
        settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme;
      root.dataset.theme = theme;
      window.ferryHost?.updateTheme(theme);
    };
    apply();
    if (settings.theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => {
      media.removeEventListener('change', apply);
    };
  }, [settings?.theme]);
  const tabs = useUI((state) => state.tabs);
  const activeId = useUI((state) => state.activeId);
  const leftCollapsed = useUI((state) => state.leftCollapsed);
  const rightCollapsed = useUI((state) => state.rightCollapsed);
  const density = useUI((state) => state.density);
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
  const onboardingPage =
    pathname === '/onboarding' || (pathname === '/' && settings?.onboardingComplete === false);
  const activeNav = onboardingPage
    ? null
    : pathname.startsWith('/explore')
      ? 'explore'
      : pathname === '/library'
        ? 'library'
        : pathname === '/' || pathname.startsWith('/s/')
          ? 'chats'
          : null;
  const fullCanvasPage = onboardingPage || pathname.includes('/review/');
  const rightWidth = useUI((state) => state.rightWidth);
  const bottomOpen = useUI((state) => state.bottomOpen);
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
      } else if (key === '`') {
        event.preventDefault();
        useUI.getState().toggleBottom();
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

  const tabItems =
    tabs.length === 0 && pathname === '/'
      ? [{ id: 'home', label: 'New Chat', icon: FileText }]
      : tabs.map((tab) => ({
          id: tab.id,
          label: labels.get(tab.id) ?? tab.title,
          icon: FileText,
          status: sessions.find((session) => session.id === tab.id)?.status ?? 'idle',
        }));
  const homeTab = tabs.length === 0 && pathname === '/';
  const currentId = pathname.startsWith('/s/')
    ? pathname.slice('/s/'.length)
    : homeTab
      ? 'home'
      : (activeId ?? '');
  return (
    <div
      className={`app-shell ${leftCollapsed ? 'left-is-collapsed' : ''} ${rightCollapsed ? 'right-is-collapsed' : ''}`}
      data-density={density}
    >
      <div className="title-strip" aria-hidden="true" />
      <div
        className={`app-grid ${fullCanvasPage ? 'page-mode-grid' : ''}`}
        style={{ '--right-width': `${String(rightWidth)}px` } as React.CSSProperties}
      >
        <Sidebar activeNav={activeNav} />
        <main className="center-column">
          <div
            className={`tabs-bar-frame ${leftCollapsed && !fullCanvasPage ? 'with-sidebar-toggle' : ''}`}
          >
            {!fullCanvasPage && leftCollapsed && (
              <button
                aria-label="Show sidebar"
                className="header-icon"
                onClick={() => {
                  useUI.getState().toggleLeft();
                }}
                title="Show sidebar · Ctrl+B"
                type="button"
              >
                <PanelLeftOpen aria-hidden="true" size={15} />
              </button>
            )}
            <TabsBar
              tabs={tabItems}
              activeId={currentId}
              onSelect={(id) => {
                if (id === 'home') {
                  void navigate({ to: '/' });
                  return;
                }
                setActive(id as (typeof tabs)[number]['id']);
                void navigate({ to: '/s/$sessionId', params: { sessionId: id } });
              }}
              {...(homeTab
                ? {}
                : {
                    onClose: (id: string) => {
                      closeTab(id as (typeof tabs)[number]['id']);
                    },
                  })}
              onAdd={() => void createChat()}
              rightCluster={
                <div className="top-cluster-with-terminal">
                  {!fullCanvasPage && (
                    <button
                      aria-label={bottomOpen ? 'Close terminal panel' : 'Open terminal panel'}
                      className="header-icon"
                      onClick={() => {
                        useUI.getState().toggleBottom();
                      }}
                      title="Terminal (Ctrl+`)"
                    >
                      <FileText size={15} />
                    </button>
                  )}
                  <TopRightCluster
                    onAccount={() => void navigate({ to: '/settings' })}
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
                  {!fullCanvasPage && rightCollapsed && (
                    <button
                      aria-label="Show panel"
                      className="header-icon"
                      onClick={() => {
                        useUI.getState().toggleRight();
                      }}
                      title="Show panel · Ctrl+Shift+B"
                      type="button"
                    >
                      <PanelRightOpen aria-hidden="true" size={15} />
                    </button>
                  )}
                </div>
              }
            />
          </div>
          {settings?.developer.injectErrors && (
            <div className="offline-warning" role="status">
              Offline · showing saved demo data
            </div>
          )}
          <div className="canvas-slot">{children}</div>
          {appMounts.main.map((Mount, index) => (
            <Mount bottomOpen={bottomOpen} fullCanvasPage={fullCanvasPage} key={index} />
          ))}
        </main>
        {!rightCollapsed && <RightPanel onNewChat={() => void createChat()} />}
      </div>
      {appMounts.overlays.map((Mount, index) => (
        <Mount bottomOpen={bottomOpen} fullCanvasPage={fullCanvasPage} key={index} />
      ))}
    </div>
  );
}
