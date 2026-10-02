import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Code2, Lightbulb, MoreHorizontal, Settings, UserRound } from 'lucide-react';
import { IntegrationItem } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useMcpServers } from '../data/queries';
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
