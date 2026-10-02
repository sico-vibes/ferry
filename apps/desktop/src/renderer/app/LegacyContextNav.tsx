import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import { ShowMoreList, Skeleton, TagBadge } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useSessions, useWorkspaces } from '../data/queries';
import { useUI } from '../state/ui';

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

export function ProviderFilterNav() {
  const navigate = useNavigate();
  const client = useFerryClient();
  const exploreFilter = useUI((state) => state.exploreFilter);
  const { data: providers = [], isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  return (
    <aside className="legacy-context-nav">
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
        {isLoading ? (
          <Skeleton rows={4} />
        ) : (
          <ShowMoreList
            items={providers.filter((provider) => {
              const kind =
                provider.tag === 'subscription_cli'
                  ? 'CLI'
                  : provider.tag === 'paid'
                    ? 'Paid'
                    : 'Free';
              return exploreFilter === 'All' || kind === exploreFilter;
            })}
            groupKey="sidebar:explore:providers"
            label="providers"
            moreLabel="providers in navigation"
            listClassName=""
            renderItem={(provider) => (
              <li className="list-none" key={provider.id}>
                <button
                  title={provider.name}
                  className="context-provider-row"
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
              </li>
            )}
          />
        )}
        {!providers.length && !isLoading && (
          <button
            className="context-provider-row"
            onClick={() => void navigate({ to: '/explore' })}
          >
            Add a provider
          </button>
        )}
      </div>
    </aside>
  );
}
