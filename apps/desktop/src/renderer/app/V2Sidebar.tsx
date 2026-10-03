import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  Ellipsis,
  MessageSquarePlus,
  Pin,
  Search,
  Settings,
  Sparkles,
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

const sessionStatusLabels: Partial<Record<SessionStatus, string>> = {
  running: 'Running',
  awaiting_approval: 'Needs approval',
  error: 'Error',
};

const {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
  const go = (path: '/' | '/library' | '/models' | '/settings') => {
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
          <FerryMark size={28} variant="brand" />
          {!collapsed && <span className="v2-brand-name">Ferry</span>}
          <Button
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className="v2-collapse"
            size="icon"
            variant="ghost"
            onClick={() => {
              useUI.getState().toggleLeft();
            }}
          >
            <ChevronLeft className={collapsed ? 'rotate-180' : ''} aria-hidden="true" />
          </Button>
        </div>
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
          <button
            className="v2-nav-button v2-search-button"
            onClick={() => window.dispatchEvent(new Event('ferry:open-command-palette'))}
            aria-label="Search, Ctrl K"
          >
            <Search aria-hidden="true" />
            {!collapsed && (
              <>
                <span>Search</span>
                <kbd>Ctrl K</kbd>
              </>
            )}
          </button>
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
                        const title = window.prompt('Rename chat', session.title)?.trim();
                        if (title) {
                          void client.sessions.rename(session.id, title).then(async () => {
                            useUI.getState().renameTab(session.id, title);
                            await cache.invalidateQueries({ queryKey: keys.sessions });
                          });
                        }
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
                        if (window.confirm(`Delete “${session.title}”?`))
                          void client.sessions.remove(session.id).then(async () => {
                            await cache.invalidateQueries({ queryKey: keys.sessions });
                            if (pathname === `/s/${session.id}`) await navigate({ to: '/' });
                          });
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
                    {displayName && <span className="v2-user-name">{displayName}</span>}
                    <ChevronDown aria-hidden="true" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="v2-user-menu">
              <DropdownMenuItem
                onSelect={() => {
                  go('/settings');
                }}
              >
                <Settings />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={settings?.theme ?? 'system'}>
                <DropdownMenuRadioItem
                  value="system"
                  onSelect={() => {
                    void updateTheme('system');
                  }}
                >
                  <SunMoon />
                  Theme: System
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="dark"
                  onSelect={() => {
                    void updateTheme('dark');
                  }}
                >
                  Dark
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="light"
                  onSelect={() => {
                    void updateTheme('light');
                  }}
                >
                  Light
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
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
                <Sparkles />
                About
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
    <button className="v2-nav-button" aria-current={active ? 'page' : undefined} onClick={onClick}>
      {icon}
      {!collapsed && <span>{label}</span>}
    </button>
  );
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}
