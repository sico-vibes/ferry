import { Profiler, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Dialog, UiV2 } from '@ferry/ui';
import type { SessionId } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { useFerryEvents } from '../data/events';
import { keys, useProfiles, useSessions, useSettings } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { RightPanel } from './right-panel/RightPanel';
import { appMounts } from './mounts';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { V2Sidebar } from './V2Sidebar';
import { V2ChatHeader } from './V2ChatHeader';
import { BottomPanel } from './BottomPanel';
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
  const { data: profiles = [] } = useProfiles();
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const theme =
        settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme;
      root.dataset.theme = theme;
      root.classList.toggle('light', theme === 'light');
      root.classList.toggle('dark', theme === 'dark');
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
  const [drawerTab, setDrawerTab] = useState<'plan' | 'changes' | 'terminal'>('plan');
  const [wideDrawer, setWideDrawer] = useState(
    () => window.matchMedia('(min-width: 1280px)').matches,
  );
  const [simulatedOffline, setSimulatedOffline] = useState(
    () => localStorage.getItem('ferry.simulateOffline') === 'true',
  );
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine);
  const { bindings } = useKeybindings();
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const sync = () => {
      setWideDrawer(media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => {
      media.removeEventListener('change', sync);
    };
  }, []);
  useEffect(() => {
    if (!rightCollapsed && pathname.startsWith('/s/') && drawerTab !== 'terminal')
      useUI.getState().setRightTab(drawerTab);
  }, [drawerTab, pathname, rightCollapsed]);
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
  const onboardingPage =
    pathname === '/onboarding' || (settings?.onboardingComplete === false && pathname === '/');
  const reviewPage = pathname.includes('/review/');
  const fullCanvasPage = onboardingPage || reviewPage;
  const bottomOpen = useUI((state) => state.bottomOpen);
  const createChat = async () => {
    try {
      const workspaces = await client.workspaces.list();
      const selectedWorkspaceId = useUI.getState().selectedWorkspaceId;
      const workspace = workspaces.find((item) => item.id === selectedWorkspaceId) ?? workspaces[0];
      if (!workspace) {
        pushToast({
          kind: 'warning',
          title: 'Add a folder first',
          body: 'Choose a workspace before starting a chat.',
        });
        return;
      }
      const profileId = profiles.find((profile) => profile.id === settings?.activeProfileId)?.id;
      const session = await client.sessions.create({
        workspaceId: workspace.id,
        ...(profileId ? { profileId } : {}),
      });
      openTab({ id: session.id, title: session.title });
      await cache.invalidateQueries({ queryKey: keys.sessions });
      useUI.getState().requestComposerFocus();
      await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Chat could not be created',
        body: error instanceof Error ? error.message : String(error),
      });
    }
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
        window.dispatchEvent(new Event('ferry:open-command-palette'));
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
        setDrawerTab('terminal');
        if (useUI.getState().rightCollapsed) useUI.getState().toggleRight();
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
    setDrawerTab,
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

  if (onboardingPage) return <main className="ferry-ui v2-onboarding-shell">{children}</main>;

  return (
    <div
      className={`ferry-ui v2-app-shell ${leftCollapsed ? 'left-is-collapsed' : ''} ${rightCollapsed || reviewPage ? 'right-is-collapsed' : ''} ${reviewPage ? 'v2-review-route' : pathname === '/' || pathname.startsWith('/s/') ? 'v2-chat-route' : pathname.startsWith('/settings') ? 'v2-settings-route' : ''}`}
      data-density={density}
    >
      <div className="title-strip" aria-hidden="true" />
      <div
        className={`v2-app-grid ${!rightCollapsed && !reviewPage && pathname.startsWith('/s/') ? 'drawer-open' : ''}`}
      >
        <V2Sidebar onNewChat={() => void createChat()} />
        <main className="v2-main-column">
          {pathname !== '/library' && !reviewPage && <V2ChatHeader />}
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
                    : pathname.startsWith('/models') || pathname.startsWith('/explore')
                      ? 'Models'
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
        </main>
        {!rightCollapsed && pathname.startsWith('/s/') && !reviewPage && (
          <UiV2.Sheet
            open
            modal={!wideDrawer}
            onOpenChange={(open) => {
              if (!open) useUI.getState().toggleRight();
            }}
          >
            <UiV2.SheetContent
              className="v2-drawer-content"
              overlayClassName="v2-drawer-overlay"
              side="right"
            >
              <UiV2.SheetHeader className="v2-drawer-heading">
                <UiV2.SheetTitle>Session details</UiV2.SheetTitle>
                <button
                  className="v2-drawer-close"
                  aria-label="Close drawer"
                  onClick={() => {
                    useUI.getState().toggleRight();
                  }}
                >
                  <ChevronRight aria-hidden="true" />
                </button>
              </UiV2.SheetHeader>
              <div aria-label="Session drawer tabs" className="v2-drawer-tabs" role="tablist">
                {(['plan', 'changes', 'terminal'] as const).map((tab) => (
                  <button
                    aria-controls="session-drawer-panel"
                    aria-selected={drawerTab === tab}
                    id={`session-drawer-tab-${tab}`}
                    key={tab}
                    onClick={() => {
                      setDrawerTab(tab);
                      if (tab === 'plan' || tab === 'changes') useUI.getState().setRightTab(tab);
                    }}
                    role="tab"
                  >
                    {tab === 'plan' ? 'Plan' : tab === 'changes' ? 'Changes' : 'Terminal'}
                  </button>
                ))}
              </div>
              <div
                aria-labelledby={`session-drawer-tab-${drawerTab}`}
                className="v2-drawer-body"
                id="session-drawer-panel"
                role="tabpanel"
              >
                {drawerTab === 'terminal' ? (
                  <BottomPanel sessionId={pathname.split('/')[2] as SessionId} />
                ) : (
                  <RightPanel
                    onNewChat={() => void createChat()}
                    sessionId={pathname.split('/')[2] as SessionId}
                  />
                )}
              </div>
            </UiV2.SheetContent>
          </UiV2.Sheet>
        )}
      </div>
      {appMounts.overlays.map((Mount, index) => (
        <Mount
          bottomOpen={bottomOpen}
          fullCanvasPage={fullCanvasPage}
          key={index}
          onNewChat={createChat}
        />
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
          <UiV2.Button
            onClick={() => {
              if (closePrompt) closeAndNavigate(closePrompt, false);
            }}
          >
            Keep running in background
          </UiV2.Button>
          <UiV2.Button
            variant="outline"
            onClick={() => {
              if (closePrompt) closeAndNavigate(closePrompt, true);
            }}
          >
            Stop
          </UiV2.Button>
        </div>
      </Dialog>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
