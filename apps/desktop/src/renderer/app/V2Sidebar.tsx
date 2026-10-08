import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  CircleHelp,
  Cloud,
  LogIn,
  LogOut,
  History,
  Info,
  Keyboard,
  MessageSquarePlus,
  Network,
  Search,
  Settings,
  SunMoon,
  Boxes,
  X,
} from 'lucide-react';
import { FerryMark, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useLimits, useSettings } from '../data/queries';
import { describeReset, describeWindow, tightestDailyWindow } from '../data/limits';
import { useUI } from '../state/ui';
import { useToasts } from '../state/toasts';
import { useDisplayName } from './useDisplayName';
import { useCloudStatus } from './CloudAccount';
import { SidebarProjects } from './SidebarProjects';

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

export function V2Sidebar({
  onNewChat,
}: {
  /** No argument: a chat without a project; a project id: a new chat in that project. */
  onNewChat: (workspaceId?: string | null) => void;
}) {
  const client = useFerryClient();
  const { data: cloud } = useCloudStatus();
  const cloudSignedIn = cloud?.auth.signedIn === true;
  const cloudRunning = (cloud?.runningMode ?? cloud?.storageMode) === 'cloud';
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const collapsed = useUI((state) => state.leftCollapsed);
  const { data: settings } = useSettings();
  const displayName = useDisplayName();
  const { data: limits = [] } = useLimits();
  const pushToast = useToasts((state) => state.push);
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
  const updateTheme = async (theme: 'system' | 'dark' | 'light') => {
    await client.settings.update({ theme });
    await cache.invalidateQueries({ queryKey: keys.settings });
  };
  const go = (path: '/' | '/models' | '/gateway') => {
    void navigate({ to: path });
  };
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const pausedCount = providers.filter((provider) => provider.pausedReason).length;
  const tightest = tightestDailyWindow(limits);
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
            onClick={() => {
              onNewChat(null);
            }}
          />
          <NavButton
            label="Models"
            indicator={pausedCount > 0 ? `${String(pausedCount)} paused providers` : undefined}
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
        {!collapsed && <SidebarProjects onNewChat={onNewChat} />}
        {collapsed && <div className="v2-rail-spacer" />}
        <div className="v2-sidebar-bottom">
          {!collapsed && !pathname.startsWith('/models') && (
            <section className="v2-capacity-card" aria-label="Daily limits">
              {tightest ? (
                <>
                  <div className="v2-capacity-top">
                    <span className="truncate">{tightest.providerName}</span>
                    <span>{String(Math.round(tightest.share * 100))}%</span>
                  </div>
                  <Progress
                    value={tightest.share * 100}
                    aria-label={`${tightest.providerName}: ${describeWindow(tightest.window)}`}
                  />
                  <small className="v2-capacity-detail">
                    {[describeWindow(tightest.window), describeReset(tightest.window)]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </>
              ) : (
                <div className="v2-capacity-top">
                  <span>No daily limits used yet today</span>
                </div>
              )}
              <button
                onClick={() => {
                  void navigate({ to: '/models/usage' });
                }}
              >
                See limits
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
  indicator,
  icon,
  active,
  collapsed,
  onClick,
}: {
  label: string;
  indicator?: string | undefined;
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
      {indicator && (
        <span
          aria-label={indicator}
          className="v2-paused-dot size-2 shrink-0 rounded-full bg-destructive"
          role="status"
        />
      )}
    </button>
  );
  return collapsed || indicator ? (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{indicator ? `${label}: ${indicator}` : label}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}
