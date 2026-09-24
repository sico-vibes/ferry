import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  FolderOpen,
  ChevronDown,
  ChevronRight,
  UserRound,
  Code2,
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
  TagBadge,
  EmptyState,
  Skeleton,
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

const settingSections = [
  'General',
  'Profiles',
  'Providers & Keys',
  'Optimizers',
  'Delegation',
  'Permissions',
  'Skills',
  'MCP',
  'Data & Privacy',
  'Developer',
  'About',
] as const;
const providerKind = (tag: string) =>
  tag === 'subscription_cli' ? 'CLI' : tag === 'paid' ? 'Paid' : 'Free';
const relativeAgo = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 60
    ? `${String(minutes)}m ago`
    : minutes < 1440
      ? `${String(Math.floor(minutes / 60))}h ago`
      : `${String(Math.floor(minutes / 1440))}d ago`;
};
export function Sidebar({
  activeNav = 'chats',
}: {
  activeNav?: 'chats' | 'library' | 'explore' | null;
}) {
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { data: profiles = [] } = useProfiles();
  const { data: settings } = useSettings();
  const { data: servers = [] } = useMcpServers();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: capacity } = useCapacity();
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => client.sessions.list(),
  });
  const { data: providers = [], isLoading: providersLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const [expanded, setExpanded] = useState<string[]>([]);
  const tabs = useUI((s) => s.tabs);
  const activeId = useUI((s) => s.activeId);
  const exploreFilter = useUI((s) => s.exploreFilter);
  const settingsSection = useUI((s) => s.settingsSection);
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
              <strong>
                {activeNav === 'library'
                  ? 'Library'
                  : activeNav === 'explore'
                    ? 'Explore'
                    : activeNav === null
                      ? 'Settings'
                      : 'Chats'}
              </strong>
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
                active={activeNav === null}
                activeStyle="neutral"
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
          {activeNav === 'library' ? (
            <div className="context-sidebar-list">
              <button className="context-primary-action" onClick={() => void chooseFolder()}>
                <FolderOpen size={15} /> Open folder
              </button>
              {workspaces.map((workspace) => {
                const isOpen = expanded.includes(workspace.id);
                const items = sessions.filter((session) => session.workspaceId === workspace.id);
                return (
                  <section className="context-sidebar-section" key={workspace.id}>
                    <button
                      className="context-sidebar-row"
                      onClick={() => {
                        setExpanded((old) =>
                          isOpen ? old.filter((id) => id !== workspace.id) : [...old, workspace.id],
                        );
                        useUI.getState().setSelectedWorkspace(workspace.id);
                      }}
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <FolderOpen size={14} />
                      <span>{workspace.name}</span>
                    </button>
                    {isOpen &&
                      items.map((session) => (
                        <button
                          className="context-session-row"
                          key={session.id}
                          onClick={() => {
                            useUI.getState().openTab({ id: session.id, title: session.title });
                            void navigate({
                              to: '/s/$sessionId',
                              params: { sessionId: session.id },
                            });
                          }}
                        >
                          {session.title}
                          <small>{relativeAgo(session.updatedAt)}</small>
                        </button>
                      ))}
                  </section>
                );
              })}
              {!workspaces.length && <p className="muted">Open a folder to add a workspace.</p>}
            </div>
          ) : activeNav === 'explore' ? (
            <div className="context-sidebar-list">
              <nav aria-label="Provider filters" className="context-filter-row">
                {(['All', 'Free', 'Paid', 'CLI'] as const).map((filter) => (
                  <button
                    aria-pressed={exploreFilter === filter}
                    key={filter}
                    onClick={() => {
                      useUI.getState().setExploreFilter(filter);
                    }}
                  >
                    {filter}
                  </button>
                ))}
              </nav>
              {providersLoading ? (
                <Skeleton rows={4} />
              ) : (
                providers
                  .filter(
                    (provider) =>
                      exploreFilter === 'All' || providerKind(provider.tag) === exploreFilter,
                  )
                  .map((provider) => (
                    <button
                      className="context-provider-row"
                      key={provider.id}
                      onClick={() =>
                        document
                          .getElementById(`provider-${provider.id}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      }
                    >
                      <span
                        className={`provider-health ${provider.health === 'ok' ? 'healthy' : provider.health === 'down' ? 'failed' : ''}`}
                      />
                      <span>{provider.name}</span>
                      <TagBadge
                        kind={
                          provider.tag === 'paid'
                            ? 'paid'
                            : provider.tag === 'subscription_cli'
                              ? 'cli'
                              : provider.tag === 'caution'
                                ? 'caution'
                                : provider.tag === 'promo'
                                  ? 'promo'
                                  : 'legit'
                        }
                      />
                    </button>
                  ))
              )}
              {!providers.length && !providersLoading && (
                <EmptyState
                  title="No providers connected"
                  action="Add a provider"
                  onAction={() => void navigate({ to: '/explore' })}
                />
              )}
            </div>
          ) : activeNav === null ? (
            <nav aria-label="Settings sections" className="context-settings-nav">
              {settingSections.map((name, index) => (
                <button
                  className={settingsSection === name ? 'active' : ''}
                  key={name}
                  onClick={() => {
                    useUI.getState().setSettingsSection(name);
                  }}
                >
                  {name === 'Developer' ? (
                    <Code2 size={15} />
                  ) : index === 0 ? (
                    <UserRound size={15} />
                  ) : index === 1 ? (
                    <BookOpen size={15} />
                  ) : index === 2 ? (
                    <Settings size={15} />
                  ) : (
                    <Lightbulb size={15} />
                  )}
                  {name}
                </button>
              ))}
            </nav>
          ) : (
            <>
              <NewChatButton onClick={() => void createChat()}>New conversation</NewChatButton>
              <FadeSeparator className="my-5" />
              <SidebarSection
                label="Pinned Profiles"
                action={() => void navigate({ to: '/explore' })}
              >
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
                        toggleServer.mutate({
                          id: server.id,
                          enabled: server.status !== 'connected',
                        });
                      }}
                    >
                      <MoreHorizontal aria-hidden="true" size={16} />
                    </button>
                  </div>
                ))}
              </SidebarSection>
            </>
          )}
        </SidebarPanel>
        {providersLoading ? (
          <Skeleton rows={2} />
        ) : !providers.length ? (
          <button className="capacity-connect" onClick={() => void navigate({ to: '/explore' })}>
            Connect a provider <span>Open Explore</span>
          </button>
        ) : capacity ? (
          <CapacityCard
            stepsLeft={capacity.stepsLeftToday}
            percent={capacity.percentRemaining}
            onAddProvider={() => void navigate({ to: '/explore' })}
            onOpenBreakdown={() => void navigate({ to: '/explore/usage' })}
          />
        ) : (
          <Skeleton rows={2} />
        )}
        <span className="sr-only">{String(tabs.length)} chats open</span>
      </div>
    </>
  );
}
