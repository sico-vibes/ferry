import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  BookOpen,
  CircleHelp,
  Lightbulb,
  MoreHorizontal,
  PanelLeft,
  Search,
  Settings,
  Sparkles,
  Zap,
} from 'lucide-react';
import {
  CapacityCard,
  FadeSeparator,
  IconRail,
  IntegrationItem,
  NewChatButton,
  SidebarItem,
  SidebarPanel,
  SidebarSection,
} from '@ferry/ui';
import { useFerryClient } from '../data/client';
import {
  keys,
  useCapacity,
  useMcpServers,
  useProfiles,
  useSettings,
  useWorkspaces,
} from '../data/queries';
import { useUI } from '../state/ui';

const profileIcons = new Map<string, typeof Lightbulb>([
  ['lightbulb', Lightbulb],
  ['sparkles', Sparkles],
  ['zap', Zap],
  ['book-open', BookOpen],
]);

export function Sidebar({ activeNav = 'chats' }: { activeNav?: 'chats' | 'library' | 'explore' }) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { data: profiles = [] } = useProfiles();
  const { data: settings } = useSettings();
  const { data: servers = [] } = useMcpServers();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: capacity } = useCapacity();
  const tabs = useUI((s) => s.tabs);
  const activeId = useUI((s) => s.activeId);
  const openTab = useUI((s) => s.openTab);
  const toggleLeft = useUI((s) => s.toggleLeft);
  const toggleRight = useUI((s) => s.toggleRight);
  const toggleTheme = async () => {
    if (settings) {
      await client.settings.update({ theme: settings.theme === 'dark' ? 'light' : 'dark' });
      await cache.invalidateQueries({ queryKey: keys.settings });
    }
  };
  const createChat = async () => {
    const list = workspaces.length ? workspaces : await client.workspaces.list();
    const workspace = list[0];
    if (!workspace) return;
    const session = await client.sessions.create({
      workspaceId: workspace.id,
      ...(settings ? { profileId: settings.activeProfileId } : {}),
    });
    openTab({ id: session.id, title: session.title });
    await cache.invalidateQueries({ queryKey: keys.sessions });
    await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
  };
  const chooseFolder = async () => {
    const path = window.ferryHost
      ? await window.ferryHost.openFolder()
      : window.prompt('Enter a folder path to add');
    if (!path) return;
    const workspace = await client.workspaces.open(path);
    await cache.invalidateQueries({ queryKey: keys.workspaces });
    useUI.getState().setRightTab('chats');
    const session = await client.sessions.create({ workspaceId: workspace.id });
    openTab({ id: session.id, title: session.title });
    await cache.invalidateQueries({ queryKey: keys.sessions });
    await navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
  };
  const activateProfile = async (id: string) => {
    await client.profiles.activate(id as (typeof profiles)[number]['id'], activeId ?? undefined);
    await cache.invalidateQueries({ queryKey: keys.profiles });
    await cache.invalidateQueries({ queryKey: keys.settings });
    if (activeId) await cache.invalidateQueries({ queryKey: keys.session(activeId) });
  };
  const toggleServer = useMutation({
    mutationFn: ({ id, enabled }: { id: (typeof servers)[number]['id']; enabled: boolean }) =>
      client.mcp.setEnabled(id, enabled),
    onSuccess: () => cache.invalidateQueries({ queryKey: keys.mcp }),
  });

  return (
    <>
      <IconRail
        active={activeNav}
        onNew={() => void createChat()}
        onNavigate={(to) => void navigate({ to: to === 'chats' ? '/' : `/${to}` })}
        onAdd={() => void chooseFolder()}
        onToggleTheme={() => void toggleTheme()}
      />
      <div className="left-column">
        <SidebarPanel
          className="sidebar-panel"
          header={
            <>
              <button aria-label="Collapse sidebar" className="header-icon" onClick={toggleLeft}>
                <PanelLeft size={16} />
              </button>
              <strong>Chats</strong>
              <button
                aria-label="Focus search"
                className="header-icon ml-auto"
                onClick={() => {
                  if (useUI.getState().rightCollapsed) toggleRight();
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLInputElement>('[aria-label="Search chats"]')
                      ?.focus(),
                  );
                }}
              >
                <Search size={16} />
              </button>
            </>
          }
          footer={
            <div className="sidebar-footer">
              <SidebarItem
                icon={Settings}
                label="Settings"
                showMenu={false}
                onClick={() => void navigate({ to: '/settings' })}
              />
              <SidebarItem
                icon={CircleHelp}
                label="Help & Support"
                showMenu={false}
                onClick={() => {
                  useUI.getState().setRightTab('plan');
                }}
              />
            </div>
          }
        >
          <NewChatButton onClick={() => void createChat()} />
          <FadeSeparator className="my-5" />
          <SidebarSection label="Pinned Profiles" action={() => void navigate({ to: '/explore' })}>
            {profiles
              .filter((profile) => profile.pinned)
              .map((profile) => {
                const Icon = profileIcons.get(profile.icon) ?? Lightbulb;
                return (
                  <SidebarItem
                    key={profile.id}
                    icon={Icon}
                    label={profile.name}
                    active={profile.id === (settings?.activeProfileId ?? 'profile_best')}
                    shimmer={profile.id === settings?.activeProfileId}
                    onClick={() => void activateProfile(profile.id)}
                  />
                );
              })}
          </SidebarSection>
          <FadeSeparator className="my-5" />
          <SidebarSection label="Integrations" action={() => void navigate({ to: '/explore' })}>
            {servers.map((server) => (
              <div className="integration-row" key={server.id}>
                <IntegrationItem
                  label={server.name}
                  slug={server.brand ?? server.name.toLowerCase()}
                  status={server.status}
                />
                <button
                  aria-label={`Toggle ${server.name}`}
                  className="integration-toggle"
                  onClick={() => {
                    toggleServer.mutate({ id: server.id, enabled: server.status !== 'connected' });
                  }}
                >
                  <MoreHorizontal aria-hidden="true" size={16} />
                </button>
              </div>
            ))}
          </SidebarSection>
        </SidebarPanel>
        {capacity && (
          <CapacityCard
            stepsLeft={capacity.stepsLeftToday}
            percent={capacity.percentRemaining}
            onAddProvider={() => void navigate({ to: '/explore' })}
            onOpenBreakdown={() => void navigate({ to: '/explore/usage' })}
          />
        )}
        <span className="sr-only">{String(tabs.length)} chats open</span>
      </div>
    </>
  );
}
