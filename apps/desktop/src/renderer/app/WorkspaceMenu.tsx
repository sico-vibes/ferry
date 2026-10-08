import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Settings2,
  SquareArrowOutUpRight,
} from 'lucide-react';
import type { SessionId, Workspace } from '@ferry/shared';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { openProjectFolder } from '../data/projects';
import { keys } from '../data/queries';
import { useProjectDialogs } from '../state/projectDialogs';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';

/**
 * Composer project chip. On Home it picks where the next chat runs: no project (a private scratch
 * folder), one of your projects, or a new one. Inside a chat it shows that chat's project and can
 * edit it, open it, or move the chat to another project.
 */
export function WorkspaceMenu({
  workspaces,
  selectedId,
  sessionId,
  lockedToSession = false,
}: {
  workspaces: Workspace[];
  selectedId: string | null | undefined;
  /** The open chat, when lockedToSession. */
  sessionId?: SessionId;
  lockedToSession?: boolean;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const selected = selectedId ? workspaces.find((workspace) => workspace.id === selectedId) : null;
  const label = selected?.name ?? 'No project';
  const moveTo = (workspaceId: Workspace['id'] | null) => {
    if (!sessionId) return;
    void client.sessions
      .move(sessionId, workspaceId)
      .then(async () => {
        await cache.invalidateQueries({ queryKey: keys.sessions });
        await cache.invalidateQueries({ queryKey: keys.session(sessionId) });
        await cache.invalidateQueries({ queryKey: keys.workspaces });
      })
      .catch((error: unknown) => {
        pushToast({
          kind: 'error',
          title: 'Chat could not be moved',
          body: error instanceof Error ? error.message : String(error),
        });
      });
  };
  return (
    <UiV2.DropdownMenu>
      <UiV2.DropdownMenuTrigger asChild>
        <button aria-label={`Project: ${label}`} className="v2-composer-tool" type="button">
          {selected ? <FolderOpen aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
          {label}
          <ChevronDown aria-hidden="true" />
        </button>
      </UiV2.DropdownMenuTrigger>
      <UiV2.DropdownMenuContent align="start" className="v2-workspace-menu" side="top">
        {lockedToSession ? (
          <>
            <UiV2.DropdownMenuLabel>This chat’s project</UiV2.DropdownMenuLabel>
            <UiV2.DropdownMenuItem disabled>
              {selected ? <FolderOpen /> : <MessageSquare />}
              <span className="v2-workspace-menu-name">
                {label}
                <small>{selected?.path ?? 'Private scratch folder for this chat'}</small>
              </span>
            </UiV2.DropdownMenuItem>
            <UiV2.DropdownMenuSeparator />
            {selected && (
              <>
                <UiV2.DropdownMenuItem
                  onSelect={() => {
                    useProjectDialogs.getState().editProject(selected.id);
                  }}
                >
                  <Settings2 />
                  Edit project
                </UiV2.DropdownMenuItem>
                <UiV2.DropdownMenuItem
                  onSelect={() => void window.ferryHost?.revealDataFolder(selected.path)}
                >
                  <SquareArrowOutUpRight />
                  Open in Explorer
                </UiV2.DropdownMenuItem>
              </>
            )}
            <UiV2.DropdownMenuSub>
              <UiV2.DropdownMenuSubTrigger>
                <FolderInput />
                Move to project
              </UiV2.DropdownMenuSubTrigger>
              <UiV2.DropdownMenuSubContent className="v2-workspace-menu">
                <UiV2.DropdownMenuItem
                  disabled={!selected}
                  onSelect={() => {
                    moveTo(null);
                  }}
                >
                  <MessageSquare />
                  No project
                </UiV2.DropdownMenuItem>
                {workspaces
                  .filter((workspace) => workspace.id !== selected?.id)
                  .map((workspace) => (
                    <UiV2.DropdownMenuItem
                      key={workspace.id}
                      onSelect={() => {
                        moveTo(workspace.id);
                      }}
                    >
                      <FolderOpen />
                      {workspace.name}
                    </UiV2.DropdownMenuItem>
                  ))}
              </UiV2.DropdownMenuSubContent>
            </UiV2.DropdownMenuSub>
          </>
        ) : (
          <>
            <UiV2.DropdownMenuLabel>Work in</UiV2.DropdownMenuLabel>
            <UiV2.DropdownMenuItem
              onSelect={() => {
                useUI.getState().setSelectedWorkspace(null);
              }}
            >
              <MessageSquare />
              <span className="v2-workspace-menu-name">
                No project
                <small>Chat with a private scratch folder</small>
              </span>
              {!selected && <Check className="v2-workspace-menu-check" />}
            </UiV2.DropdownMenuItem>
            {workspaces.map((workspace) => (
              <UiV2.DropdownMenuItem
                key={workspace.id}
                onSelect={() => {
                  useUI.getState().setSelectedWorkspace(workspace.id);
                }}
              >
                <FolderOpen />
                <span className="v2-workspace-menu-name">
                  {workspace.name}
                  <small>{workspace.path}</small>
                </span>
                {workspace.id === selected?.id && <Check className="v2-workspace-menu-check" />}
              </UiV2.DropdownMenuItem>
            ))}
            <UiV2.DropdownMenuSeparator />
            <UiV2.DropdownMenuItem onSelect={() => void openProjectFolder(client, cache)}>
              <FolderPlus />
              New project…
            </UiV2.DropdownMenuItem>
          </>
        )}
      </UiV2.DropdownMenuContent>
    </UiV2.DropdownMenu>
  );
}
