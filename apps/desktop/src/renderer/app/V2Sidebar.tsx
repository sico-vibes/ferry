import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Cloud,
  LogIn,
  LogOut,
  History,
  Info,
  Keyboard,
  Ellipsis,
  MessageSquarePlus,
  Network,
  Pin,
  Search,
  Settings,
  SunMoon,
  Boxes,
  Trash2,
  Pencil,
  X,
} from 'lucide-react';
import { FerryMark, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useCapacity, useSettings } from '../data/queries';
import { useUI } from '../state/ui';
import { useToasts } from '../state/toasts';
import type { SessionId, SessionStatus } from '@ferry/shared';
import { useDisplayName } from './useDisplayName';
import { ConfirmDialog } from './ConfirmDialog';
import { useCloudStatus } from './CloudAccount';

const sessionStatusLabels: Partial<Record<SessionStatus, string>> = {
  running: 'Running',
  awaiting_approval: 'Needs approval',
  error: 'Error',
};

const {
  Avatar,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DialogClose,
  Progress,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} = UiV2;

export function V2Sidebar({ onNewChat }: { onNewChat: () => void }) {
  const client = useFerryClient();
  const { data: cloud } = useCloudStatus();
  const cloudSignedIn = cloud?.auth.signedIn === true;
  const cloudRunning = (cloud?.runningMode ?? cloud?.storageMode) === 'cloud';
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const collapsed = useUI((state) => state.leftCollapsed);
  const { data: sessions = [] } = useQuery({
    queryKey: keys.sessions,
    queryFn: () => client.sessions.list(),
  });
  const { data: settings } = useSettings();
  const displayName = useDisplayName();
  const { data: capacity } = useCapacity();
  const pushToast = useToasts((state) => state.push);
  const [showAll, setShowAll] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [deleteSession, setDeleteSession] = useState<SessionId | null>(null);
  const [renameSession, setRenameSession] = useState<SessionId | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const { data: systemInfo } = useQuery({
    queryKey: keys.system,
    queryFn: () => client.system.info(),
    enabled: aboutOpen,
  });
  const { data: appInfo } = useQuery({
    queryKey: ['host-app-info'],
    queryFn: () => window.ferryHost?.getAppInfo() ?? Promise.resolve(null),
    enabled: aboutOpen && typeof window.ferryHost?.getAppInfo === 'function',
  });
  const appVersion =
    appInfo?.version ?? (systemInfo?.mock ? systemInfo.version : window.ferryHost?.versions.app);
  const dataFolder = appInfo?.dataDir ?? (systemInfo?.mock ? systemInfo.dataDir : null);
  const orderedSessions = useMemo(() => {
    const pinned = sessions
      .filter((session) => session.pinned)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const recent = sessions
      .filter((session) => !session.pinned)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...pinned, ...recent];
  }, [sessions]);
  const updateTheme = async (theme: 'system' | 'dark' | 'light') => {
    await client.settings.update({ theme });
    await cache.invalidateQueries({ queryKey: keys.settings });
  };
  const go = (path: '/' | '/library' | '/models' | '/gateway') => {
    void navigate({ to: path });
  };
  const activateSession = (id: SessionId, title: string) => {
    useUI.getState().openTab({ id, title });
    void navigate({ to: '/s/$sessionId', params: { sessionId: id } });
  };
  const count = capacity?.stepsLeftToday ?? 0;
  const percent = capacity?.percentRemaining ?? 0;
  const shown = showAll ? orderedSessions : orderedSessions.slice(0, 6);
  return (
    <TooltipProvider>
      <aside className={`v2-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="App sidebar">
        <div className="v2-brand-row">
          <FerryMark size={collapsed ? 18 : 20} variant="brand" />
          {!collapsed && <span className="v2-brand-name">Ferry</span>}
        </div>
        {collapsed ? (
          <NavButton
            label="Search (Ctrl K)"
            icon={<Search />}
            collapsed
            onClick={() => window.dispatchEvent(new Event('ferry:open-command-palette'))}
          />
        ) : (
          <button
            aria-label="Search, Ctrl K"
            className="v2-sidebar-search"
            onClick={() => window.dispatchEvent(new Event('ferry:open-command-palette'))}
            type="button"
          >
            <Search aria-hidden="true" />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
        )}
        <nav aria-label="Primary" className="v2-primary-nav">
          <NavButton
            label="New chat"
            icon={<MessageSquarePlus />}
            collapsed={collapsed}
            onClick={onNewChat}
          />
          <NavButton
            label="Library"
            icon={<BookOpen />}
            active={pathname.startsWith('/library')}
            collapsed={collapsed}
            onClick={() => {
              go('/library');
            }}
          />
          <NavButton
            label="Models"
            icon={<Boxes />}
            active={pathname.startsWith('/models') || pathname.startsWith('/explore')}
            collapsed={collapsed}
            onClick={() => {
              go('/models');
            }}
          />
          <NavButton
            label="Gateway"
            icon={<Network />}
            active={pathname.startsWith('/gateway')}
            collapsed={collapsed}
            onClick={() => {
              go('/gateway');
            }}
          />
        </nav>
        {!collapsed && (
          <section className="v2-chat-list" aria-label="Chats">
            <div className="v2-section-label">
              <span>Chats</span>
            </div>
            {shown.map((session) => (
              <div
                className="v2-chat-row"
                key={session.id}
                data-active={pathname === `/s/${session.id}`}
              >
                <button
                  className="v2-chat-open"
                  aria-current={pathname === `/s/${session.id}` ? 'page' : undefined}
                  data-session-id={session.id}
                  onClick={() => {
                    activateSession(session.id, session.title);
                  }}
                  title={session.title}
                >
                  <span>{session.title}</span>
                  {sessionStatusLabels[session.status] && (
                    <span
                      aria-label={sessionStatusLabels[session.status]}
                      className="v2-chat-status-dot"
                      data-status={session.status}
                      role="img"
                    />
                  )}
                  {session.pinned && <Pin size={14} role="img" aria-label="Pinned" />}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="v2-chat-menu-trigger"
                      aria-label={`Chat actions for ${session.title}`}
                    >
                      <Ellipsis aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        setRenameValue(session.title);
                        setRenameSession(session.id);
                      }}
                    >
                      <Pencil />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        void client.sessions
                          .setPinned(session.id, !session.pinned)
                          .then(() => cache.invalidateQueries({ queryKey: keys.sessions }))
                      }
                    >
                      <Pin />
                      {session.pinned ? 'Unpin' : 'Pin'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => {
                        setDeleteSession(session.id);
                      }}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
            {orderedSessions.length > 6 && (
              <button
                className="v2-chat-show-more"
                onClick={() => {
                  setShowAll((value) => !value);
                }}
              >
                {showAll ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                {showAll ? 'Show less' : 'Show more'}
              </button>
            )}
          </section>
        )}
        {collapsed && <div className="v2-rail-spacer" />}
        <div className="v2-sidebar-bottom">
          {!collapsed && !pathname.startsWith('/models') && (
            <section className="v2-capacity-card" aria-label="Capacity">
              <div className="v2-capacity-top">
                <span>≈ {String(count)} steps left today</span>
                <span>{String(percent)}%</span>
              </div>
              <Progress value={percent} aria-label={`${String(percent)}% capacity remaining`} />
              <button
                onClick={() => {
                  go('/models');
                }}
              >
                Add provider
              </button>
            </section>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="v2-user-row" aria-label="User menu">
                <Avatar>
                  <AvatarFallback>{displayName?.[0]?.toUpperCase() ?? ''}</AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <>
                    <span className="v2-user-labels">
                      <span className="v2-user-name">{displayName ?? 'Account'}</span>
                      <span className="v2-user-tier">
                        {cloudSignedIn
                          ? 'Ferry Cloud'
                          : cloudRunning
                            ? 'Cloud · signed out'
                            : 'This device'}
                      </span>
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align={collapsed ? 'start' : 'end'}
              side="top"
              className="v2-user-menu"
            >
              <DropdownMenuLabel className="v2-user-account">
                {cloudSignedIn
                  ? (cloud.auth.email ?? 'Ferry Cloud')
                  : (window.ferryHost?.displayName ?? displayName ?? 'Local account')}
                <span className="v2-user-account-detail">
                  {cloudSignedIn
                    ? cloud.sync.lastError
                      ? 'Sync error, open Storage & Cloud'
                      : `${String(cloud.sync.pending)} waiting to sync`
                    : cloudRunning
                      ? 'Cloud sync paused until you sign in'
                      : 'Data stays on this device'}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  useUI.getState().openSettings('Storage & Cloud');
                }}
              >
                {cloudRunning && !cloudSignedIn ? <LogIn /> : <Cloud />}
                {cloudRunning && !cloudSignedIn ? 'Sign in to Ferry Cloud' : 'Storage & Cloud'}
              </DropdownMenuItem>
              {cloudSignedIn ? (
                <DropdownMenuItem onSelect={() => void client.cloud.signOut()}>
                  <LogOut />
                  Sign out of Ferry Cloud
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onSelect={() => {
                  useUI.getState().openSettings();
                }}
              >
                <Settings />
                Settings
                <DropdownMenuShortcut>Ctrl+,</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SunMoon />
                  Theme
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="v2-theme-menu">
                  <DropdownMenuRadioGroup value={settings?.theme ?? 'system'}>
                    <DropdownMenuRadioItem
                      value="system"
                      onSelect={() => void updateTheme('system')}
                    >
                      System
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="light" onSelect={() => void updateTheme('light')}>
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark" onSelect={() => void updateTheme('dark')}>
                      Dark
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                onSelect={() => {
                  window.dispatchEvent(new Event('ferry:show-shortcuts'));
                }}
              >
                <Keyboard />
                Keyboard shortcuts
                <DropdownMenuShortcut>Ctrl+/</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void navigate({ to: '/models/usage' })}>
                <History />
                Usage
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void window.ferryHost?.openHelp().catch((error: unknown) => {
                    pushToast({
                      kind: 'error',
                      title: 'Help could not be opened',
                      body: error instanceof Error ? error.message : String(error),
                    });
                  });
                }}
              >
                <CircleHelp />
                Help
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setAboutOpen(true);
                }}
              >
                <Info />
                About Ferry
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <UiV2.Dialog
          open={renameSession !== null}
          onOpenChange={(open) => {
            if (!open) setRenameSession(null);
          }}
        >
          <UiV2.DialogContent>
            <UiV2.DialogHeader>
              <UiV2.DialogTitle>Rename chat</UiV2.DialogTitle>
              <UiV2.DialogDescription>Choose a title for this chat.</UiV2.DialogDescription>
            </UiV2.DialogHeader>
            <UiV2.Input
              aria-label="Chat title"
              autoFocus
              value={renameValue}
              onChange={(event) => {
                setRenameValue(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  event.currentTarget
                    .closest('[role="dialog"]')
                    ?.querySelector<HTMLButtonElement>('[data-save-chat-name]')
                    ?.click();
              }}
            />
            <div className="v2-library-dialog-actions">
              <UiV2.Button
                variant="secondary"
                onClick={() => {
                  setRenameSession(null);
                }}
              >
                Cancel
              </UiV2.Button>
              <UiV2.Button
                data-save-chat-name
                disabled={!renameValue.trim()}
                onClick={() => {
                  if (!renameSession) return;
                  const id = renameSession;
                  const title = renameValue.trim();
                  void client.sessions.rename(id, title).then(async () => {
                    useUI.getState().renameTab(id, title);
                    await cache.invalidateQueries({ queryKey: keys.sessions });
                    setRenameSession(null);
                  });
                }}
              >
                Save name
              </UiV2.Button>
            </div>
          </UiV2.DialogContent>
        </UiV2.Dialog>
        <ConfirmDialog
          open={deleteSession !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteSession(null);
          }}
          title="Delete chat?"
          description="This permanently removes the chat from Ferry."
          confirmLabel="Delete chat"
          destructive
          onConfirm={() => {
            if (!deleteSession) return;
            const id = deleteSession;
            setDeleteSession(null);
            void client.sessions.remove(id).then(async () => {
              await cache.invalidateQueries({ queryKey: keys.sessions });
              if (pathname === `/s/${id}`) await navigate({ to: '/' });
            });
          }}
        />
        <UiV2.Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
          <UiV2.DialogContent className="v2-about-dialog">
            <DialogClose aria-label="Close About dialog" autoFocus className="v2-about-close">
              <X aria-hidden="true" />
            </DialogClose>
            <UiV2.DialogHeader>
              <UiV2.DialogTitle>About Ferry</UiV2.DialogTitle>
              <UiV2.DialogDescription>
                Ferry desktop for routing coding work.
              </UiV2.DialogDescription>
            </UiV2.DialogHeader>
            <dl className="v2-about-details">
              <div>
                <dt>App version</dt>
                <dd>{appVersion ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>{window.ferryHost?.channel ?? 'beta'}</dd>
              </div>
              <div>
                <dt>Engine version</dt>
                <dd>{systemInfo?.version ?? 'Unavailable'}</dd>
              </div>
              {dataFolder && (
                <div className="v2-about-data-folder">
                  <dt>Data folder</dt>
                  <dd>{dataFolder}</dd>
                  {window.ferryHost && (
                    <UiV2.Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void window.ferryHost
                          ?.revealDataFolder(dataFolder)
                          .catch((error: unknown) => {
                            pushToast({
                              kind: 'error',
                              title: 'Data folder could not be revealed',
                              body: error instanceof Error ? error.message : String(error),
                            });
                          });
                      }}
                    >
                      Reveal
                    </UiV2.Button>
                  )}
                </div>
              )}
              <div>
                <dt>License</dt>
                <dd>MIT</dd>
              </div>
            </dl>
          </UiV2.DialogContent>
        </UiV2.Dialog>
      </aside>
    </TooltipProvider>
  );
}

function NavButton({
  label,
  icon,
  active,
  collapsed,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const button = (
    <button
      aria-label={label}
      className="v2-nav-button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
    </button>
  );
  return collapsed ? (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}
