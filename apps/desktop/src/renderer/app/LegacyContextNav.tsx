import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  FolderOpen,
  Lightbulb,
  MoreHorizontal,
  Settings,
  UserRound,
} from 'lucide-react';
import { IntegrationItem, ShowMoreList } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useMcpServers, useSessions, useWorkspaces } from '../data/queries';
import { useUI } from '../state/ui';

const settingSections = [
  'General',
  'Profiles',
  'Providers & Keys',
  'Gateway',
  'Advanced',
  'Optimizers',
  'Delegation',
  'Permissions',
  'Skills',
  'MCP',
  'Data & Privacy',
  'Developer',
  'About',
] as const;

function relativeAgo(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 60
    ? `${String(minutes)}m ago`
    : minutes < 1440
      ? `${String(Math.floor(minutes / 60))}h ago`
      : `${String(Math.floor(minutes / 1440))}d ago`;
}

export function LibraryWorkspaceNav() {
  const { data: workspaces = [] } = useWorkspaces();
  const { data: sessions = [] } = useSessions();
  const navigate = useNavigate();
  const client = useFerryClient();
  const cache = useQueryClient();
  const [expanded, setExpanded] = useState<string[]>([]);

  const openFolder = async () => {
    const path = window.ferryHost
      ? await window.ferryHost.openFolder()
      : window.prompt('Enter a folder path to add');
    if (!path) return;
    await client.workspaces.open(path);
    await cache.invalidateQueries({ queryKey: keys.workspaces });
  };

  return (
    <aside className="legacy-context-nav" aria-label="Workspace navigation">
      <button className="context-primary-action" onClick={() => void openFolder()}>
        <FolderOpen size={15} /> Open folder
      </button>
      {workspaces.map((workspace) => {
        const isOpen = expanded.includes(workspace.id);
        const items = sessions.filter((session) => session.workspaceId === workspace.id);
        return (
          <section className="context-sidebar-section" key={workspace.id}>
            <button
              className="context-sidebar-row"
              aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} workspace ${workspace.name}`}
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
            {isOpen && (
              <ShowMoreList
                items={items}
                groupKey={`sidebar:workspace:${workspace.id}`}
                label="sessions"
                listClassName=""
                renderItem={(session) => (
                  <li className="list-none" key={session.id}>
                    <button
                      className="context-session-row"
                      onClick={() => {
                        useUI.getState().openTab({ id: session.id, title: session.title });
                        void navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
                      }}
                    >
                      {session.title}
                      {session.status === 'interrupted' && (
                        <span className="rounded-pill bg-warn/10 px-2 py-0.5 text-meta text-warn">
                          Interrupted
                        </span>
                      )}
                      <small>{relativeAgo(session.updatedAt)}</small>
                    </button>
                  </li>
                )}
              />
            )}
          </section>
        );
      })}
      {!workspaces.length && <p className="muted">Open a folder to add a workspace.</p>}
    </aside>
  );
}

export function SettingsSectionNav() {
  const section = useUI((state) => state.settingsSection);
  const client = useFerryClient();
  const cache = useQueryClient();
  const { data: servers = [] } = useMcpServers();
  const toggleServer = useMutation({
    mutationFn: ({ id, enabled }: { id: (typeof servers)[number]['id']; enabled: boolean }) =>
      client.mcp.setEnabled(id, enabled),
    onSuccess: () => cache.invalidateQueries({ queryKey: keys.mcp }),
  });
  return (
    <aside className="legacy-context-nav legacy-settings-context">
      <nav aria-label="Settings sections" className="context-settings-nav">
        {settingSections.map((name, index) => (
          <button
            className={section === name ? 'active' : ''}
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
      <section className="legacy-integrations" aria-label="Integrations">
        <h2>Integrations</h2>
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
      </section>
    </aside>
  );
}
