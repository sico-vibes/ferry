import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Clock3,
  ExternalLink,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
  Search,
  X,
} from 'lucide-react';
import type { Session, Workspace, WorkspaceSettings } from '@ferry/shared';
import { UiV2, PageHeader } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useProfiles, useSessions, useWorkspaces } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { ApprovalsTray } from './SessionPowerControls';
import { ConfirmDialog } from './ConfirmDialog';
import { TextPromptDialog } from './TextPromptDialog';

const {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} = UiV2;

type ProjectTab = 'sessions' | 'instructions' | 'permissions';

function relativeActivity(value: string) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${String(days)}d ago`;
}

function sessionActivity(sessions: Session[], workspaceId: Workspace['id']) {
  return sessions
    .filter((session) => session.workspaceId === workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function projectActivity(workspace: Workspace, sessions: Session[]) {
  return sessionActivity(sessions, workspace.id)[0]?.updatedAt ?? workspace.lastOpenedAt;
}

function loadProjectNames(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('ferry.library.projectNames') ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function LibraryCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const toast = useToasts((state) => state.push);
  const { data: workspaces = [], isLoading: workspacesLoading } = useWorkspaces();
  const { data: sessions = [] } = useSessions();
  const { data: profiles = [] } = useProfiles();

  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [detailId, setDetailId] = useState<Workspace['id'] | null>(null);
  const [tab, setTab] = useState<ProjectTab>('sessions');
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [approvingLanes, setApprovingLanes] = useState(false);
  const [gate, setGate] = useState('');
  const [selectedForRemoval, setSelectedForRemoval] = useState<Workspace | null>(null);
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [projectNames, setProjectNames] = useState(loadProjectNames);
  const [folderPromptOpen, setFolderPromptOpen] = useState(false);
  const [projectConfigPromptOpen, setProjectConfigPromptOpen] = useState(false);
  const selected = workspaces.find((workspace) => workspace.id === detailId) ?? null;
  const { data: lanes = [] } = useQuery({
    queryKey: ['lanes', selected?.id],
    queryFn: () => client.delegation.lanes(),
    enabled: Boolean(selected && tab === 'permissions'),
  });
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return workspaces.filter((workspace) => {
      const name = projectNames[workspace.id] ?? workspace.name;
      return (
        !needle ||
        `${name} ${workspace.path} ${workspace.gitBranch ?? ''}`
          .toLocaleLowerCase()
          .includes(needle)
      );
    });
  }, [projectNames, query, workspaces]);
  const visibleWorkspaces = showAll ? filtered : filtered.slice(0, 10);
  const recent = selected ? sessionActivity(sessions, selected.id) : [];
  const projectLanes = lanes.filter((lane) => lane.source === 'project');
  const projectLanesApproved =
    projectLanes.length > 0 && projectLanes.every((lane) => lane.trusted);
  const activeSettings = selected
    ? settings && detailId === selected.id
      ? settings
      : selected.settings
    : null;
  const hasUnsavedChanges =
    selected !== null &&
    settings !== null &&
    detailId === selected.id &&
    settings !== selected.settings;

  const updateField = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
    if (!selected) return;
    setSettings((previous) => ({ ...(previous ?? selected.settings), [key]: value }));
  };
  const selectProject = (workspace: Workspace) => {
    setDetailId(workspace.id);
    setSettings(workspace.settings);
    setTab('sessions');
    useUI.getState().setSelectedWorkspace(workspace.id);
  };
  const chooseFolder = async () => {
    if (!window.ferryHost) {
      setFolderPromptOpen(true);
      return;
    }
    const path = await window.ferryHost.openFolder();
    if (!path) return;
    await client.workspaces.open(path);
    await cache.invalidateQueries({ queryKey: keys.workspaces });
  };
  const save = async () => {
    if (!selected || !activeSettings) return;
    const updated = await client.workspaces.update(selected.id, activeSettings);
    setSettings(updated.settings);
    await cache.invalidateQueries({ queryKey: keys.workspaces });
    toast({ kind: 'success', title: 'Project settings saved', body: selected.name });
  };
  const remove = async () => {
    if (!selectedForRemoval) return;
    const removed = selectedForRemoval;
    await client.workspaces.remove(removed.id);
    if (detailId === removed.id) {
      setDetailId(null);
      setSettings(null);
      useUI.getState().setSelectedWorkspace(null);
    }
    await cache.invalidateQueries({ queryKey: keys.workspaces });
    await cache.invalidateQueries({ queryKey: keys.sessions });
    setSelectedForRemoval(null);
  };
  const saveName = () => {
    if (!renaming) return;
    const next = renameValue.trim();
    if (!next) return;
    const updated = { ...projectNames, [renaming.id]: next };
    setProjectNames(updated);
    localStorage.setItem('ferry.library.projectNames', JSON.stringify(updated));
    setRenaming(null);
  };
  const revealPath = async (workspace: Workspace) => {
    await navigator.clipboard.writeText(workspace.path);
    toast({ kind: 'success', title: 'Project path copied', body: workspace.path });
  };

  return (
    <main className="v2-library-page">
      {selected && (
        <Button
          className="v2-library-back"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDetailId(null);
          }}
        >
          <ArrowLeft aria-hidden="true" />
          Library
        </Button>
      )}
      <PageHeader
        className="v2-library-header"
        title={selected ? (projectNames[selected.id] ?? selected.name) : 'Library'}
        subtitle={selected ? selected.path : 'Projects Ferry has opened'}
        primaryAction={
          <div className="v2-library-header-actions">
            <ApprovalsTray />
            <Button className="v2-library-open" onClick={() => void chooseFolder()}>
              <FolderOpen aria-hidden="true" />
              Open folder
            </Button>
          </div>
        }
      />

      {selected && activeSettings ? (
        <section
          className="v2-project-detail"
          aria-label={`${projectNames[selected.id] ?? selected.name} project`}
        >
          <div className="v2-project-meta">
            {selected.gitBranch && (
              <span>
                <GitBranch aria-hidden="true" />
                {selected.gitBranch}
              </span>
            )}
            <span>
              <Clock3 aria-hidden="true" />
              Active {relativeActivity(projectActivity(selected, sessions))}
            </span>
          </div>
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as ProjectTab);
            }}
          >
            <TabsList aria-label="Project details" className="v2-project-tabs">
              <TabsTrigger
                value="sessions"
                id="project-tab-sessions"
                aria-controls="project-panel-sessions"
              >
                Sessions
              </TabsTrigger>
              <TabsTrigger
                value="instructions"
                id="project-tab-instructions"
                aria-controls="project-panel-instructions"
              >
                Instructions
              </TabsTrigger>
              <TabsTrigger
                value="permissions"
                id="project-tab-permissions"
                aria-controls="project-panel-permissions"
              >
                Permissions
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="sessions"
              id="project-panel-sessions"
              aria-labelledby="project-tab-sessions"
              role="tabpanel"
              className="v2-project-tab-content"
            >
              <div className="v2-project-section-heading">
                <div>
                  <h2>Sessions</h2>
                  <p>Recent work in this project.</p>
                </div>
                <span className="v2-project-count">{recent.length}</span>
              </div>
              {recent.length ? (
                <ul className="v2-session-list">
                  {recent.map((session) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        onClick={() =>
                          void navigate({ to: '/s/$sessionId', params: { sessionId: session.id } })
                        }
                      >
                        <span>{session.title}</span>
                        <small>{relativeActivity(session.updatedAt)}</small>
                        <ExternalLink aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="v2-library-empty-copy">No sessions in this project yet.</p>
              )}
            </TabsContent>
            <TabsContent
              value="instructions"
              id="project-panel-instructions"
              aria-labelledby="project-tab-instructions"
              role="tabpanel"
              className="v2-project-tab-content"
            >
              <div className="v2-project-section-heading">
                <div>
                  <h2>Instructions</h2>
                  <p>Choose the project guidance and checks Ferry should follow.</p>
                </div>
              </div>
              <div className="v2-project-form-row">
                <label htmlFor="project-instructions-file">Instructions file</label>
                <select
                  id="project-instructions-file"
                  value={activeSettings.instructionsFile ?? 'none'}
                  onChange={(event) => {
                    updateField(
                      'instructionsFile',
                      event.currentTarget.value === 'none' ? null : event.currentTarget.value,
                    );
                  }}
                >
                  <option value="none">None</option>
                  {['AGENTS.md', 'FERRY.md', 'CLAUDE.md'].map((name) => (
                    <option value={name} key={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="v2-project-form-row">
                <label htmlFor="project-default-profile">Default profile</label>
                <select
                  id="project-default-profile"
                  value={activeSettings.defaultProfileId ?? 'default'}
                  onChange={(event) => {
                    updateField(
                      'defaultProfileId',
                      event.currentTarget.value === 'default'
                        ? null
                        : (event.currentTarget.value as WorkspaceSettings['defaultProfileId']),
                    );
                  }}
                >
                  <option value="default">Use app default</option>
                  {profiles.map((profile) => (
                    <option value={profile.id} key={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
              <section className="v2-project-subsection">
                <div>
                  <h3>Gate commands</h3>
                  <p>Commands Ferry runs before a change is ready.</p>
                </div>
                <ul className="v2-gate-list">
                  {activeSettings.gateCommands.map((command) => (
                    <li key={command}>
                      <code>{command}</code>
                      <button
                        type="button"
                        aria-label={`Remove ${command}`}
                        onClick={() => {
                          updateField(
                            'gateCommands',
                            activeSettings.gateCommands.filter((item) => item !== command),
                          );
                        }}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
                <form
                  className="v2-gate-add"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = gate.trim();
                    if (value && !activeSettings.gateCommands.includes(value))
                      updateField('gateCommands', [...activeSettings.gateCommands, value]);
                    setGate('');
                  }}
                >
                  <Input
                    aria-label="Add gate command"
                    value={gate}
                    onChange={(event) => {
                      setGate(event.currentTarget.value);
                    }}
                    placeholder="Add a command"
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    size="icon"
                    aria-label="Add gate command"
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                </form>
              </section>
              {hasUnsavedChanges && (
                <div className="v2-project-save-row">
                  <span>Unsaved changes</span>
                  <Button variant="secondary" size="sm" onClick={() => void save()}>
                    Save changes
                  </Button>
                </div>
              )}
            </TabsContent>
            <TabsContent
              value="permissions"
              id="project-panel-permissions"
              aria-labelledby="project-tab-permissions"
              role="tabpanel"
              className="v2-project-tab-content"
            >
              <div className="v2-project-section-heading">
                <div>
                  <h2>Permissions</h2>
                  <p>Control how much Ferry can do without asking.</p>
                </div>
              </div>
              <div className="v2-project-form-row">
                <label htmlFor="project-permission-mode">Permission mode</label>
                <select
                  id="project-permission-mode"
                  value={activeSettings.permissionMode}
                  onChange={(event) => {
                    updateField(
                      'permissionMode',
                      event.currentTarget.value as WorkspaceSettings['permissionMode'],
                    );
                  }}
                >
                  <option value="ask">Ask before each action</option>
                  <option value="auto_edit">Edit files, ask before commands</option>
                  <option value="full_auto">Run automatically</option>
                </select>
              </div>
              <section className="v2-project-subsection">
                <div className="v2-project-section-heading">
                  <div>
                    <h3>Project lanes</h3>
                    <p>Review project-provided delegation lanes before trusting them.</p>
                  </div>
                  {projectLanes.length > 0 &&
                    (projectLanesApproved ? (
                      <span aria-label="Approved" className="v2-lane-trusted" role="status">
                        Approved
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={approvingLanes}
                        onClick={() => {
                          setApprovingLanes(true);
                          void client.delegation
                            .approveProjectLanes()
                            .then(async () => {
                              await cache.invalidateQueries({ queryKey: ['lanes'] });
                            })
                            .catch((error: unknown) => {
                              toast({
                                kind: 'error',
                                title: 'Could not approve project lanes',
                                body: error instanceof Error ? error.message : 'Try again.',
                              });
                            })
                            .finally(() => {
                              setApprovingLanes(false);
                            });
                        }}
                      >
                        {approvingLanes ? 'Approving' : 'Approve project lanes'}
                      </Button>
                    ))}
                </div>
                {lanes.filter((lane) => lane.source === 'project').length ? (
                  <ul className="v2-lane-list">
                    {lanes
                      .filter((lane) => lane.source === 'project')
                      .map((lane) => (
                        <li key={lane.name}>
                          <span>
                            <strong>{lane.name}</strong>
                            <small>
                              {lane.implementer}
                              {lane.model ? ` / ${lane.model}` : ''}
                            </small>
                          </span>
                          <span className={lane.trusted ? 'v2-lane-trusted' : 'v2-lane-pending'}>
                            {lane.trusted ? 'Trusted' : 'Needs approval'}
                          </span>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="v2-library-empty-copy">No project lanes detected.</p>
                )}
              </section>
              <section className="v2-project-subsection v2-project-config">
                <div>
                  <h3>Project config</h3>
                  <p>
                    Approve this exact config file to apply its permission rules and gate commands.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setProjectConfigPromptOpen(true);
                  }}
                >
                  Approve project config
                </Button>
              </section>
              {hasUnsavedChanges && (
                <div className="v2-project-save-row">
                  <span>Unsaved changes</span>
                  <Button variant="secondary" size="sm" onClick={() => void save()}>
                    Save changes
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </section>
      ) : (
        <section className="v2-library-list-view" aria-label="Projects">
          <div className="v2-library-search-wrap">
            <Search aria-hidden="true" />
            <Input
              aria-label="Search projects"
              placeholder="Search projects"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setShowAll(false);
              }}
            />
          </div>
          {workspacesLoading ? (
            <div className="v2-library-loading" role="status" aria-label="Loading projects">
              {Array.from({ length: 5 }, (_, index) => (
                <div className="v2-library-skeleton-row" key={index}>
                  <Skeleton />
                  <Skeleton />
                  <Skeleton />
                  <Skeleton />
                </div>
              ))}
            </div>
          ) : workspaces.length === 0 ? (
            <div className="v2-library-empty">
              <FolderOpen aria-hidden="true" />
              <h2>No projects yet</h2>
              <p>Open a folder to start working with a project in Ferry.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="v2-library-empty v2-library-no-results">
              <h2>No matching projects</h2>
              <p>Try another name, path, or branch.</p>
              <Button
                variant="ghost"
                onClick={() => {
                  setQuery('');
                }}
              >
                Clear search
              </Button>
            </div>
          ) : (
            <>
              <div className="v2-library-table" role="table" aria-label="Projects">
                <div className="v2-library-table-head" role="row">
                  <span role="columnheader">Project</span>
                  <span role="columnheader">Path</span>
                  <span role="columnheader">Branch</span>
                  <span role="columnheader">Last activity</span>
                  <span aria-hidden="true" />
                </div>
                {visibleWorkspaces.map((workspace) => (
                  <div
                    className="v2-library-row"
                    role="row"
                    key={workspace.id}
                    onClick={(event) => {
                      if (event.target instanceof Element && event.target.closest('button')) return;
                      selectProject(workspace);
                    }}
                  >
                    <div className="v2-library-cell v2-library-project-cell" role="cell">
                      <button
                        className="v2-library-project-link"
                        type="button"
                        aria-label={`Open project ${projectNames[workspace.id] ?? workspace.name}`}
                        onClick={() => {
                          selectProject(workspace);
                        }}
                      >
                        <FolderOpen aria-hidden="true" />
                        <span>{projectNames[workspace.id] ?? workspace.name}</span>
                      </button>
                    </div>
                    <span
                      className="v2-library-cell v2-library-path-cell"
                      role="cell"
                      title={workspace.path}
                    >
                      {workspace.path}
                    </span>
                    <span className="v2-library-cell v2-library-branch" role="cell">
                      {workspace.gitBranch ? (
                        <>
                          <GitBranch aria-hidden="true" />
                          {workspace.gitBranch}
                        </>
                      ) : (
                        <span className="v2-library-dash">No branch</span>
                      )}
                    </span>
                    <span className="v2-library-cell v2-library-activity" role="cell">
                      {relativeActivity(projectActivity(workspace, sessions))}
                    </span>
                    <div className="v2-library-row-menu" role="cell">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${projectNames[workspace.id] ?? workspace.name}`}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setRenaming(workspace);
                              setRenameValue(projectNames[workspace.id] ?? workspace.name);
                            }}
                          >
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void revealPath(workspace)}>
                            Reveal path
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={() => {
                              setSelectedForRemoval(workspace);
                            }}
                          >
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
              {filtered.length > 10 && !showAll && (
                <Button
                  className="v2-library-show-more"
                  variant="ghost"
                  onClick={() => {
                    setShowAll(true);
                  }}
                >
                  Show more projects
                </Button>
              )}
            </>
          )}
        </section>
      )}

      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>Choose the name Ferry shows for this project.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Project name"
            value={renameValue}
            onChange={(event) => {
              setRenameValue(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveName();
            }}
          />
          <div className="v2-library-dialog-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setRenaming(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={saveName} disabled={!renameValue.trim()}>
              Save name
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(selectedForRemoval)}
        onOpenChange={(open) => {
          if (!open) setSelectedForRemoval(null);
        }}
        title={`Remove ${selectedForRemoval ? (projectNames[selectedForRemoval.id] ?? selectedForRemoval.name) : 'project'}?`}
        description="This removes the project from Ferry. Its files stay on disk."
        confirmLabel="Remove project"
        destructive
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={projectConfigPromptOpen}
        onOpenChange={setProjectConfigPromptOpen}
        title="Approve project config?"
        description="Review .ferry/config.json before its permission rules and gates can run."
        confirmLabel="Approve config"
        onConfirm={() => {
          setProjectConfigPromptOpen(false);
          void client.delegation.approveProjectConfig().then((result) => {
            if (!result.approved)
              toast({ kind: 'error', title: 'No project config found', body: null });
          });
        }}
      />
      <TextPromptDialog
        open={folderPromptOpen}
        onOpenChange={setFolderPromptOpen}
        title="Add a project folder"
        description="Enter the full path to the folder you want to open."
        label="Folder path"
        placeholder="Example: C:/Projects/my-app"
        onSubmit={(path) => {
          setFolderPromptOpen(false);
          void client.workspaces
            .open(path)
            .then(() => cache.invalidateQueries({ queryKey: keys.workspaces }));
        }}
      />
    </main>
  );
}
