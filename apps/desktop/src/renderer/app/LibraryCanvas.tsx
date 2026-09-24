import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GitBranch,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Save,
  Trash2,
  Copy,
  ExternalLink,
} from 'lucide-react';
import type { Workspace, WorkspaceSettings } from '@ferry/shared';
import {
  Dialog,
  DropdownMenu,
  EmptyState,
  Pill,
  Select,
  SegmentedControl,
  Skeleton,
} from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useProfiles, useSessions, useWorkspaces } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';

function ago(value: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3600000));
  return hours < 1
    ? 'Just now'
    : hours < 24
      ? `${String(hours)}h ago`
      : `${String(Math.floor(hours / 24))}d ago`;
}
function openFolder() {
  return window.ferryHost
    ? window.ferryHost.openFolder()
    : window.prompt('Enter a folder path to add');
}

export function LibraryCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const toast = useToasts((state) => state.push);
  const [workspaceToRemove, setWorkspaceToRemove] = useState<Workspace | null>(null);
  const { data: workspaces = [], isLoading: workspacesLoading } = useWorkspaces();
  const { data: sessions = [] } = useSessions();
  const { data: profiles = [] } = useProfiles();
  const { data: lanes = [] } = useQuery({
    queryKey: ['lanes'],
    queryFn: () => client.delegation.lanes(),
  });
  const selectedId = useUI((state) => state.selectedWorkspaceId);
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0];
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [gate, setGate] = useState('');
  const current = selected
    ? settings && (selectedId === null || selected.id === selectedId)
      ? settings
      : selected.settings
    : null;
  const recent = useMemo(
    () =>
      sessions
        .filter((session) => session.workspaceId === selected?.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, selected?.id],
  );
  const setField = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
    setSettings((old) => ({ ...(old ?? selected?.settings), [key]: value }) as WorkspaceSettings);
  };
  const chooseFolder = async () => {
    const path = await openFolder();
    if (!path) return;
    const workspace = await client.workspaces.open(path);
    useUI.getState().setSelectedWorkspace(workspace.id);
    setSettings(workspace.settings);
    await cache.invalidateQueries({ queryKey: keys.workspaces });
  };
  const remove = async (workspace: Workspace) => {
    await client.workspaces.remove(workspace.id);
    if (workspace.id === selected?.id) {
      useUI.getState().setSelectedWorkspace(null);
      setSettings(null);
    }
    await cache.invalidateQueries({ queryKey: keys.workspaces });
    await cache.invalidateQueries({ queryKey: keys.sessions });
    toast({
      kind: 'success',
      title: 'Workspace removed',
      body: `${workspace.name} was removed from Ferry. Files remain on disk.`,
    });
  };
  const save = async () => {
    if (!selected || !current) return;
    await client.workspaces.update(selected.id, current);
    await cache.invalidateQueries({ queryKey: keys.workspaces });
    toast({ kind: 'success', title: 'Workspace settings saved', body: selected.name });
  };
  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path);
    toast({ kind: 'success', title: 'Path copied', body: path });
  };
  return (
    <section className="canvas ferry-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">WORKSPACES</span>
          <h1>Library</h1>
          <p>Folders and repos Ferry has opened</p>
        </div>
        <Pill onClick={() => void chooseFolder()} leadingIcon={<FolderOpen size={15} />}>
          Open folder
        </Pill>
      </header>
      <div className="library-layout">
        <div className="library-list">
          {workspaces.map((workspace) => (
            <article
              key={workspace.id}
              className={`workspace-card ${selected?.id === workspace.id ? 'is-selected' : ''}`}
            >
              <div className="workspace-card-top">
                <div className="workspace-glyph">
                  <FolderOpen size={17} />
                </div>
                <DropdownMenu
                  trigger={
                    <button className="quiet-icon" aria-label={`Actions for ${workspace.name}`}>
                      <MoreHorizontal size={17} />
                    </button>
                  }
                  items={[
                    {
                      label: 'Open',
                      icon: <ExternalLink size={14} />,
                      onSelect: () => {
                        useUI.getState().setSelectedWorkspace(workspace.id);
                        setSettings(workspace.settings);
                      },
                    },
                    {
                      label: 'Reveal path',
                      icon: <Copy size={14} />,
                      onSelect: () => void copyPath(workspace.path),
                    },
                    {
                      label: 'Remove',
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onSelect: () => {
                        setWorkspaceToRemove(workspace);
                      },
                    },
                  ]}
                />
              </div>
              <button
                aria-pressed={selected?.id === workspace.id}
                className="workspace-select"
                onClick={() => {
                  useUI.getState().setSelectedWorkspace(workspace.id);
                  setSettings(workspace.settings);
                }}
                type="button"
              >
                <h2>{workspace.name}</h2>
                <code>{workspace.path}</code>
                <span className="workspace-meta">
                  <span className="chip">{workspace.language.toUpperCase()}</span>
                  {workspace.gitBranch && (
                    <span>
                      <GitBranch size={13} />
                      {workspace.gitBranch}
                    </span>
                  )}
                  <span>{ago(workspace.lastOpenedAt)}</span>
                </span>
                <small>
                  {sessions.filter((session) => session.workspaceId === workspace.id).length}{' '}
                  sessions
                </small>
              </button>
            </article>
          ))}
          {workspacesLoading ? (
            <Skeleton rows={4} />
          ) : (
            !workspaces.length && (
              <EmptyState
                title="No workspaces yet"
                action="Open your first folder"
                onAction={() => void chooseFolder()}
                icon={<FolderOpen size={22} />}
              />
            )
          )}
        </div>
        {selected && current ? (
          <div className="workspace-detail">
            <div className="detail-heading">
              <div>
                <span className="eyebrow">WORKSPACE SETTINGS</span>
                <h2>{selected.name}</h2>
              </div>
              <Pill size="sm" onClick={() => void save()} leadingIcon={<Save size={14} />}>
                Save
              </Pill>
            </div>
            <section className="settings-group">
              <h3>Gate commands</h3>
              <p>Commands Ferry should run before a change is ready.</p>
              <div className="gate-chips">
                {current.gateCommands.map((command) => (
                  <button
                    key={command}
                    className="chip removable"
                    onClick={() => {
                      setField(
                        'gateCommands',
                        current.gateCommands.filter((entry) => entry !== command),
                      );
                    }}
                  >
                    {command}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (gate.trim())
                      setField('gateCommands', [...current.gateCommands, gate.trim()]);
                    setGate('');
                  }}
                >
                  <input
                    aria-label="Add gate command"
                    value={gate}
                    onChange={(event) => {
                      setGate(event.target.value);
                    }}
                    placeholder="Add command"
                  />
                  <button aria-label="Add gate command">
                    <Plus size={14} />
                  </button>
                </form>
              </div>
            </section>
            <section className="settings-group two-fields">
              <label>
                <span>Instructions file</span>
                <Select
                  label="Instructions file"
                  value={current.instructionsFile ?? 'none'}
                  onValueChange={(value) => {
                    setField('instructionsFile', value === 'none' ? null : value);
                  }}
                  options={[
                    { value: 'none', label: 'None' },
                    ...['AGENTS.md', 'FERRY.md', 'CLAUDE.md'].map((name) => ({
                      value: name,
                      label: name,
                    })),
                  ]}
                />
              </label>
              <label>
                <span>Default profile</span>
                <Select
                  label="Default profile"
                  value={current.defaultProfileId ?? 'default'}
                  onValueChange={(value) => {
                    setField(
                      'defaultProfileId',
                      value === 'default' ? null : (value as WorkspaceSettings['defaultProfileId']),
                    );
                  }}
                  options={[
                    { value: 'default', label: 'Use app default' },
                    ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
                  ]}
                />
              </label>
            </section>
            <section className="settings-group">
              <h3>Permission mode</h3>
              <p>
                {current.permissionMode === 'ask'
                  ? 'Ferry asks before each command or file change.'
                  : current.permissionMode === 'auto_edit'
                    ? 'Ferry edits files and asks before running commands.'
                    : 'Ferry can edit files and run commands automatically.'}
              </p>
              <SegmentedControl
                label="Permission mode"
                value={current.permissionMode}
                onValueChange={(value) => {
                  setField('permissionMode', value as WorkspaceSettings['permissionMode']);
                }}
                options={[
                  { value: 'ask', label: 'Ask' },
                  { value: 'auto_edit', label: 'Auto-edit' },
                  { value: 'full_auto', label: 'Full auto' },
                ]}
              />
            </section>
            <section className="settings-group">
              <div className="group-title">
                <div>
                  <h3>Project lanes</h3>
                  <p>Delegation lanes declared by this repository.</p>
                </div>
                {lanes.some((lane) => lane.source === 'project') && (
                  <Pill
                    size="sm"
                    onClick={() =>
                      void client.delegation.approveProjectLanes().then(async () => {
                        await cache.invalidateQueries({ queryKey: ['lanes'] });
                        toast({
                          kind: 'success',
                          title: 'Project lanes approved',
                          body: 'They are now trusted for this workspace.',
                        });
                      })
                    }
                  >
                    Approve project lanes
                  </Pill>
                )}
              </div>
              {lanes
                .filter((lane) => lane.source === 'project')
                .map((lane) => (
                  <div className="lane-row" key={lane.name}>
                    <span>{lane.name}</span>
                    <small>
                      {lane.implementer}
                      {lane.model ? ` · ${lane.model}` : ''}
                    </small>
                    <span className={`status-pill ${lane.trusted ? 'ok' : 'pending'}`}>
                      {lane.trusted ? 'Trusted' : 'Needs approval'}
                    </span>
                  </div>
                ))}
              {!lanes.some((lane) => lane.source === 'project') && (
                <small className="muted">No project lanes detected.</small>
              )}
            </section>
            <section className="settings-group">
              <h3>Recent sessions</h3>
              {recent.slice(0, 5).map((session) => (
                <div className="session-row" key={session.id}>
                  <span>{session.title}</span>
                  <small>{ago(session.updatedAt)}</small>
                </div>
              ))}
              {!recent.length && (
                <small className="muted">No sessions in this workspace yet.</small>
              )}
            </section>
          </div>
        ) : (
          <div className="workspace-detail empty-card">
            <FolderOpen size={24} />
            <p>Select a workspace to manage its settings</p>
          </div>
        )}
      </div>
      <Dialog
        open={Boolean(workspaceToRemove)}
        onOpenChange={(open) => {
          if (!open) setWorkspaceToRemove(null);
        }}
        title={`Remove ${workspaceToRemove?.name ?? 'workspace'}?`}
        description="This removes the folder from Ferry. Its files stay on disk."
      >
        <div className="button-row dialog-actions">
          <Pill
            onClick={() => {
              setWorkspaceToRemove(null);
            }}
          >
            Cancel
          </Pill>
          <Pill
            variant="warm-outline"
            onClick={() => {
              if (workspaceToRemove) void remove(workspaceToRemove);
              setWorkspaceToRemove(null);
            }}
          >
            Remove workspace
          </Pill>
        </div>
      </Dialog>
    </section>
  );
}
