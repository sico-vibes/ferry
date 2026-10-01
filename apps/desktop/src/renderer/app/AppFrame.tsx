import { Profiler, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { FileText, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { Dialog, Pill, TabsBar, TopRightCluster } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys, useSessions, useSettings } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { Sidebar } from './Sidebar';
import { RightPanel } from './right-panel/RightPanel';
import { appMounts } from './mounts';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { ConfigurationSheet } from './ConfigurationSheet';
import type { SessionId } from '@ferry/shared';
import type { UpdateSnapshot } from '../../main/update-state.js';
import { initializeKeybindings } from '../state/keybindings';
import { useKeybindings } from '../state/keybindings';
import { matchesKeybinding } from '@ferry/config/keybindings';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [engineRestarting, setEngineRestarting] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateSnapshot | null>(null);
  useFerryEvents();
  useEffect(() => {
    if (!window.ferryHost) return;
    const sync = (backgrounded: boolean) => {
      document.documentElement.dataset.windowBackgrounded = String(backgrounded);
      window.dispatchEvent(new CustomEvent('ferry:window-background', { detail: backgrounded }));
    };
    sync(window.ferryHost.isWindowBackgrounded());
    return window.ferryHost.onWindowBackground(sync);
  }, []);
  useEffect(() => {
    if (!window.ferryHost) return;
    let active = true;
    void window.ferryHost.getEngineStatus().then((status) => {
      if (active) setEngineRestarting(status.status === 'restarting');
    });
    const off = window.ferryHost.onEngineRestarting(() => {
      setEngineRestarting(true);
    });
    const offConnected = window.ferryHost.onEngineConnected(() => {
      setEngineRestarting(false);
    });
    return () => {
      active = false;
      off();
      offConnected();
    };
  }, []);
  useEffect(() => {
    if (!window.ferryHost) return;
    let active = true;
    void window.ferryHost.getUpdateState().then((state) => {
      if (active) setUpdateState(state);
    });
    const off = window.ferryHost.onUpdateState(setUpdateState);
    return () => {
      active = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (!window.ferryHost) return;
    return window.ferryHost.onOpenWorkspace((path) => {
      void client.workspaces.open(path).then(async (workspace) => {
        useUI.getState().setSelectedWorkspace(workspace.id);
        await cache.invalidateQueries({ queryKey: keys.workspaces });
        await navigate({ to: '/' });
      });
    });
  }, [cache, client, navigate]);
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
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [completedDelegationIds, setCompletedDelegationIds] = useState<string[]>([]);
  const [simulatedOffline, setSimulatedOffline] = useState(
    () => localStorage.getItem('ferry.simulateOffline') === 'true',
  );
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine);
  const { bindings } = useKeybindings();
  useEffect(() => {
    return initializeKeybindings((message) => {
      pushToast({ kind: 'error', title: 'Keybindings could not be loaded', body: message });
    });
  }, [pushToast]);
  useEffect(() => {
    const online = () => {
      setNetworkOnline(true);
    };
    const offline = () => {
      setNetworkOnline(false);
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);
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
  const closeAndNavigate = (id: string, stop: boolean) => {
    if (stop) void client.sessions.cancel(id as (typeof sessions)[number]['id']);
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    closeTab(id as (typeof tabs)[number]['id']);
    setClosePrompt(null);
    if (activeId === id) {
      const destination = next[Math.min(index, next.length - 1)];
      if (destination) {
        setActive(destination.id);
        void navigate({ to: '/s/$sessionId', params: { sessionId: destination.id } });
      } else {
        void navigate({ to: '/' });
      }
    }
  };
  const requestCloseTab = (id: string) => {
    const session = sessions.find((item) => item.id === id);
    if (session?.status === 'running' || session?.status === 'awaiting_approval') {
      setClosePrompt(id);
      return;
    }
    closeAndNavigate(id, false);
  };

  useEffect(() => {
    const pulse = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId: string }>).detail.sessionId;
      if (!id) return;
      setCompletedDelegationIds((current) => [...new Set([...current, id])]);
    };
    window.addEventListener('ferry:success-pulse', pulse);
    return () => {
      window.removeEventListener('ferry:success-pulse', pulse);
    };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      const context = {
        editableFocus:
          target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)),
        terminalFocus:
          target instanceof HTMLElement && Boolean(target.closest('.xterm, [data-terminal-focus]')),
        paletteOpen: Boolean(document.querySelector('.command-dialog')),
        isDesktop: Boolean(window.ferryHost),
      };
      const matches = (command: string) => {
        const binding = bindings.find((item) => item.command === command);
        return binding ? matchesKeybinding(binding, event, context) : false;
      };
      if (matches('shortcuts.open')) {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (matches('chat.new')) {
        event.preventDefault();
        void createChat();
      } else if (matches('panel.toggle')) {
        event.preventDefault();
        useUI.getState().toggleRight();
      } else if (matches('sidebar.toggle')) {
        event.preventDefault();
        useUI.getState().toggleLeft();
      } else if (matches('search.open')) {
        event.preventDefault();
        if (useUI.getState().rightCollapsed) useUI.getState().toggleRight();
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>('[aria-label="Search chats"]')?.focus(),
        );
      } else if (matches('tab.close') && activeId) {
        event.preventDefault();
        requestCloseTab(activeId);
      } else if (matches('tab.next') && tabs.length > 1) {
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.id === activeId);
        const next = tabs[(index + 1) % tabs.length];
        if (next) {
          setActive(next.id);
          void navigate({ to: '/s/$sessionId', params: { sessionId: next.id } });
        }
      } else if (matches('terminal.toggle')) {
        event.preventDefault();
        useUI.getState().toggleBottom();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [
    activeId,
    bindings,
    cache,
    closeTab,
    createChat,
    navigate,
    openTab,
    pushToast,
    requestCloseTab,
    setActive,
    tabs,
    sessions,
  ]);

  useEffect(() => {
    const openShortcuts = () => {
      setShortcutsOpen(true);
    };
    window.addEventListener('ferry:show-shortcuts', openShortcuts);
    return () => {
      window.removeEventListener('ferry:show-shortcuts', openShortcuts);
    };
  }, []);

  useEffect(() => {
    const syncOffline = () => {
      setSimulatedOffline(localStorage.getItem('ferry.simulateOffline') === 'true');
    };
    window.addEventListener('ferry:offline-change', syncOffline);
    return () => {
      window.removeEventListener('ferry:offline-change', syncOffline);
    };
  }, []);

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
      ? [{ id: 'home', label: 'New Chat', ariaLabel: 'New Chat (tab)', icon: FileText }]
      : tabs.map((tab) => ({
          id: tab.id,
          label: labels.get(tab.id) ?? tab.title,
          icon: FileText,
          status: sessions.find((session) => session.id === tab.id)?.status ?? 'idle',
          successPulse: completedDelegationIds.includes(tab.id),
        }));
  const homeTab = tabs.length === 0 && pathname === '/';
  const currentId = pathname.startsWith('/s/')
    ? pathname.slice('/s/'.length)
    : homeTab
      ? 'home'
      : (activeId ?? '');
  const configurationSessionId = pathname.startsWith('/s/')
    ? (pathname.slice('/s/'.length).split('/')[0] as SessionId | undefined)
    : undefined;
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
                    onClose: requestCloseTab,
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
                    showShare={false}
                    onConfiguration={() => {
                      setConfigurationOpen(true);
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
          {(!networkOnline || simulatedOffline) && (
            <div className="offline-warning" role="status">
              Offline - local work is saved. Provider requests will retry when the network returns.
            </div>
          )}
          {engineRestarting && (
            <div className="engine-restarting" role="status">
              Engine restarting…
            </div>
          )}
          {updateState?.status === 'downloaded' && (
            <div className="update-banner" role="status">
              <span>Update available{updateState.version ? ` · ${updateState.version}` : ''}</span>
              <button
                type="button"
                onClick={() => {
                  void window.ferryHost?.installUpdate();
                }}
              >
                Restart to update
              </button>
            </div>
          )}
          <div className="canvas-slot">
            {import.meta.env.DEV && new URLSearchParams(location.search).has('perf-render') ? (
              <Profiler
                id={
                  pathname.startsWith('/s/')
                    ? 'Session'
                    : pathname.startsWith('/explore')
                      ? 'Explore'
                      : pathname.startsWith('/settings')
                        ? 'Settings'
                        : 'Home'
                }
                onRender={(id) => {
                  const counts = (window.ferryPerfRenderCounts ??= {});
                  counts[id] = (counts[id] ?? 0) + 1;
                }}
              >
                {children}
              </Profiler>
            ) : (
              children
            )}
          </div>
          {appMounts.main.map((Mount, index) => (
            <Mount bottomOpen={bottomOpen} fullCanvasPage={fullCanvasPage} key={index} />
          ))}
        </main>
        {!rightCollapsed && <RightPanel onNewChat={() => void createChat()} />}
      </div>
      {appMounts.overlays.map((Mount, index) => (
        <Mount bottomOpen={bottomOpen} fullCanvasPage={fullCanvasPage} key={index} />
      ))}
      <Dialog
        open={Boolean(closePrompt)}
        onOpenChange={(open) => {
          if (!open) setClosePrompt(null);
        }}
        title="Stop the run?"
        description="This session is still running. Stop it or keep it running in the background."
      >
        <div className="button-row dialog-actions">
          <Pill
            onClick={() => {
              if (closePrompt) closeAndNavigate(closePrompt, false);
            }}
          >
            Keep running in background
          </Pill>
          <Pill
            variant="warm-outline"
            onClick={() => {
              if (closePrompt) closeAndNavigate(closePrompt, true);
            }}
          >
            Stop
          </Pill>
        </div>
      </Dialog>
      <ConfigurationSheet
        open={configurationOpen}
        onOpenChange={setConfigurationOpen}
        sessionId={configurationSessionId}
      />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
