import { useMemo, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HoverCard } from 'radix-ui';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Settings2,
  SquareArrowOutUpRight,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { UiV2 } from '@ferry/ui';
import type { Session, SessionId, SessionStatus, Workspace, WorkspaceId } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { openProjectFolder } from '../data/projects';
import { keys, useWorkspaces } from '../data/queries';
import { useProjectDialogs } from '../state/projectDialogs';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';
import { ConfirmDialog } from './ConfirmDialog';

const {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} = UiV2;

const statusLabels: Partial<Record<SessionStatus, string>> = {
  running: 'Running',
  awaiting_approval: 'Needs approval',
  error: 'Error',
};
const expandedKey = 'ferry.sidebar.collapsedProjects';

function byActivity(a: Session, b: Session) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}
function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(expandedKey) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Codex-style chat list: Projects (each with its chats) and Recents (chats without a project). */
export function SidebarProjects({
  onNewChat,
}: {
  onNewChat: (workspaceId: string | null) => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pushToast = useToasts((state) => state.push);
  const { data: sessions = [] } = useQuery({
    queryKey: keys.sessions,
    queryFn: () => client.sessions.list(),
  });
  const { data: workspaces = [] } = useWorkspaces();
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsed);
  const [expandedLists, setExpandedLists] = useState<Set<string>>(new Set());
  const [renameChat, setRenameChat] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteChat, setDeleteChat] = useState<Session | null>(null);
  const [archiveProject, setArchiveProject] = useState<Workspace | null>(null);
  const [removeProject, setRemoveProject] = useState<Workspace | null>(null);

  const active = sessions.filter((session) => !session.archived);
  const chatsByProject = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of active) {
      const key = session.workspaceId ?? '';
      map.set(key, [...(map.get(key) ?? []), session]);
    }
    for (const list of map.values()) list.sort(byActivity);
    return map;
  }, [active]);
  const projects = useMemo(
    () =>
      [...workspaces].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.lastActivityAt ?? b.lastOpenedAt).localeCompare(
          a.lastActivityAt ?? a.lastOpenedAt,
        );
      }),
    [workspaces],
  );
  const recents = chatsByProject.get('') ?? [];

  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: keys.sessions });
    await cache.invalidateQueries({ queryKey: keys.workspaces });
  };
  const report = (title: string) => (error: unknown) => {
    pushToast({
      kind: 'error',
      title,
      body: error instanceof Error ? error.message : String(error),
    });
  };
  const toggleProject = (id: string) => {
    setCollapsedProjects((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      try {
        localStorage.setItem(expandedKey, JSON.stringify(next));
      } catch {
        /* The list still toggles; it just won't be remembered. */
      }
      return next;
    });
  };
  const openChat = (session: Session) => {
    useUI.getState().openTab({ id: session.id, title: session.title });
    void navigate({ to: '/s/$sessionId', params: { sessionId: session.id } });
  };
  const chatList = (key: string, list: Session[], limit: number, nested: boolean) => {
    const expanded = expandedLists.has(key);
    const shown = expanded ? list : list.slice(0, limit);
    return (
      <>
        {shown.map((session) => (
          <ChatRow
            key={session.id}
            session={session}
            nested={nested}
            active={pathname === `/s/${session.id}`}
            projects={projects}
            onOpen={() => {
              openChat(session);
            }}
            onRename={() => {
              setRenameValue(session.title);
              setRenameChat(session);
            }}
            onPin={() =>
              void client.sessions
                .setPinned(session.id, !session.pinned)
                .then(refresh)
                .catch(report('Chat could not be pinned'))
            }
            onMove={(workspaceId) =>
              void client.sessions
                .move(session.id, workspaceId)
                .then(refresh)
                .catch(report('Chat could not be moved'))
            }
            onArchive={() =>
              void client.sessions
                .archive(session.id, true)
                .then(async () => {
                  await refresh();
                  if (pathname === `/s/${session.id}`) await navigate({ to: '/' });
                })
                .catch(report('Chat could not be archived'))
            }
            onDelete={() => {
              setDeleteChat(session);
            }}
          />
        ))}
        {list.length > limit && (
          <button
            className={`v2-chat-show-more ${nested ? 'is-nested' : ''}`}
            type="button"
            onClick={() => {
              setExpandedLists((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            }}
          >
            {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            {expanded ? 'Show less' : `Show ${String(list.length - limit)} more`}
          </button>
        )}
      </>
    );
  };

  return (
    <div className="v2-chat-list v2-sidebar-projects">
      <section aria-label="Projects">
        <div className="v2-section-label v2-section-label-row">
          <button
            aria-expanded={projectsOpen}
            className="v2-section-toggle"
            type="button"
            onClick={() => {
              setProjectsOpen((value) => !value);
            }}
          >
            Projects
            {projectsOpen ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronRight aria-hidden="true" />
            )}
          </button>
          <button
            aria-label="New project"
            className="v2-section-action"
            title="New project"
            type="button"
            onClick={() =>
              void openProjectFolder(client, cache).catch(report('Project could not be opened'))
            }
          >
            <FolderPlus aria-hidden="true" />
          </button>
        </div>
        {projectsOpen &&
          (projects.length === 0 ? (
            <button
              className="v2-project-empty"
              type="button"
              onClick={() => void openProjectFolder(client, cache)}
            >
              <FolderPlus aria-hidden="true" />
              Open a folder as a project
            </button>
          ) : (
            projects.map((project) => {
              const chats = chatsByProject.get(project.id) ?? [];
              const open = !collapsedProjects.includes(project.id);
              return (
                <div className="v2-project-group" key={project.id}>
                  <div className="v2-project-row">
                    <HoverCard.Root openDelay={500} closeDelay={100}>
                      <HoverCard.Trigger asChild>
                        <button
                          aria-expanded={open}
                          className="v2-project-open"
                          type="button"
                          onClick={() => {
                            toggleProject(project.id);
                          }}
                        >
                          {open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
                          <span>{project.name}</span>
                          {project.pinned && <Pin aria-label="Pinned" role="img" size={12} />}
                        </button>
                      </HoverCard.Trigger>
                      <HoverCard.Portal>
                        <HoverCard.Content
                          align="start"
                          className="ferry-ui v2-project-card"
                          side="right"
                          // Clear the row's "…" and new-chat buttons; the card opens past the sidebar.
                          sideOffset={72}
                        >
                          <strong>
                            <FolderOpen aria-hidden="true" />
                            {project.name}
                          </strong>
                          <span>
                            <MessageSquare aria-hidden="true" />
                            {project.chatCount === 1
                              ? '1 chat'
                              : `${String(project.chatCount)} chats`}
                          </span>
                          <span title={project.path}>
                            <Folder aria-hidden="true" />
                            {project.path}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              useProjectDialogs.getState().editProject(project.id);
                            }}
                          >
                            <Settings2 aria-hidden="true" />
                            Edit project
                          </button>
                        </HoverCard.Content>
                      </HoverCard.Portal>
                    </HoverCard.Root>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          aria-label={`Project actions for ${project.name}`}
                          className="v2-row-action"
                          type="button"
                        >
                          <Ellipsis aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem
                          onSelect={() =>
                            void client.workspaces
                              .update(project.id, { pinned: !project.pinned })
                              .then(refresh)
                              .catch(report('Project could not be pinned'))
                          }
                        >
                          {project.pinned ? <PinOff /> : <Pin />}
                          {project.pinned ? 'Unpin' : 'Pin'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            useProjectDialogs.getState().editProject(project.id);
                          }}
                        >
                          <Settings2 />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => void window.ferryHost?.revealDataFolder(project.path)}
                        >
                          <SquareArrowOutUpRight />
                          Open in Explorer
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={chats.length === 0}
                          onSelect={() => {
                            setArchiveProject(project);
                          }}
                        >
                          <Archive />
                          Archive chats
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onSelect={() => {
                            setRemoveProject(project);
                          }}
                        >
                          <X />
                          Remove project
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <button
                      aria-label={`New chat in ${project.name}`}
                      className="v2-row-action"
                      title={`New chat in ${project.name}`}
                      type="button"
                      onClick={() => {
                        onNewChat(project.id);
                      }}
                    >
                      <SquarePen aria-hidden="true" />
                    </button>
                  </div>
                  {open &&
                    (chats.length ? (
                      chatList(project.id, chats, 5, true)
                    ) : (
                      <p className="v2-project-no-chats">No chats yet</p>
                    ))}
                </div>
              );
            })
          ))}
      </section>
      <section aria-label="Recents">
        <div className="v2-section-label">
          <span>Recents</span>
        </div>
        {recents.length ? (
          chatList('recents', recents, 10, false)
        ) : (
          <p className="v2-project-no-chats is-flat">Chats without a project appear here.</p>
        )}
      </section>

      <UiV2.Dialog
        open={renameChat !== null}
        onOpenChange={(open) => {
          if (!open) setRenameChat(null);
        }}
      >
        <UiV2.DialogContent>
          <UiV2.DialogHeader>
            <UiV2.DialogTitle>Rename chat</UiV2.DialogTitle>
            <UiV2.DialogDescription>Choose a title for this chat.</UiV2.DialogDescription>
          </UiV2.DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const title = renameValue.trim();
              if (!renameChat || !title) return;
              const id = renameChat.id;
              void client.sessions
                .rename(id, title)
                .then(async () => {
                  useUI.getState().renameTab(id, title);
                  await refresh();
                  setRenameChat(null);
                })
                .catch(report('Chat could not be renamed'));
            }}
          >
            <UiV2.Input
              aria-label="Chat title"
              autoFocus
              value={renameValue}
              onChange={(event) => {
                setRenameValue(event.currentTarget.value);
              }}
            />
            <div className="v2-library-dialog-actions">
              <UiV2.Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setRenameChat(null);
                }}
              >
                Cancel
              </UiV2.Button>
              <UiV2.Button type="submit" disabled={!renameValue.trim()}>
                Save name
              </UiV2.Button>
            </div>
          </form>
        </UiV2.DialogContent>
      </UiV2.Dialog>
      <ConfirmDialog
        open={deleteChat !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteChat(null);
        }}
        title="Delete chat?"
        description="This permanently removes the chat from Ferry. Archive keeps it instead."
        confirmLabel="Delete chat"
        destructive
        onConfirm={() => {
          if (!deleteChat) return;
          const id: SessionId = deleteChat.id;
          setDeleteChat(null);
          void client.sessions
            .remove(id)
            .then(async () => {
              await refresh();
              if (pathname === `/s/${id}`) await navigate({ to: '/' });
            })
            .catch(report('Chat could not be deleted'));
        }}
      />
      <ConfirmDialog
        open={archiveProject !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveProject(null);
        }}
        title={`Archive chats in ${archiveProject?.name ?? 'this project'}?`}
        description="They leave the sidebar but stay in Ferry; search can still find them."
        confirmLabel="Archive chats"
        onConfirm={() => {
          if (!archiveProject) return;
          const id: WorkspaceId = archiveProject.id;
          setArchiveProject(null);
          void client.workspaces
            .archiveChats(id)
            .then(refresh)
            .catch(report('Chats could not be archived'));
        }}
      />
      <ConfirmDialog
        open={removeProject !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveProject(null);
        }}
        title={`Remove ${removeProject?.name ?? 'project'}?`}
        description="Ferry forgets this project and archives its chats. Your files stay on disk."
        confirmLabel="Remove project"
        destructive
        onConfirm={() => {
          if (!removeProject) return;
          const id = removeProject.id;
          setRemoveProject(null);
          void client.workspaces
            .remove(id)
            .then(async () => {
              if (useUI.getState().selectedWorkspaceId === id)
                useUI.getState().setSelectedWorkspace(null);
              await refresh();
            })
            .catch(report('Project could not be removed'));
        }}
      />
    </div>
  );
}

function ChatRow({
  session,
  nested,
  active,
  projects,
  onOpen,
  onRename,
  onPin,
  onMove,
  onArchive,
  onDelete,
}: {
  session: Session;
  nested: boolean;
  active: boolean;
  projects: Workspace[];
  onOpen: () => void;
  onRename: () => void;
  onPin: () => void;
  onMove: (workspaceId: WorkspaceId | null) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const status = statusLabels[session.status];
  return (
    <div className={`v2-chat-row ${nested ? 'is-nested' : ''}`} data-active={active}>
      <button
        aria-current={active ? 'page' : undefined}
        className="v2-chat-open"
        data-session-id={session.id}
        title={session.title}
        type="button"
        onClick={onOpen}
      >
        <span>{session.title}</span>
        {status && (
          <span
            aria-label={status}
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
            aria-label={`Chat actions for ${session.title}`}
            className="v2-chat-menu-trigger"
            type="button"
          >
            <Ellipsis aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onPin}>
            {session.pinned ? <PinOff /> : <Pin />}
            {session.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={session.status === 'running'}>
              <FolderInput />
              Move to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                disabled={!session.workspaceId}
                onSelect={() => {
                  onMove(null);
                }}
              >
                <MessageSquare />
                No project
              </DropdownMenuItem>
              {projects
                .filter((project) => project.id !== session.workspaceId)
                .map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={() => {
                      onMove(project.id);
                    }}
                  >
                    <FolderOpen />
                    {project.name}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={onArchive}>
            <Archive />
            Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
