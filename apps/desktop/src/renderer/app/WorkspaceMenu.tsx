import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronDown, FolderCog, FolderOpen, FolderPlus } from 'lucide-react';
import type { Workspace } from '@ferry/shared';
import { UiV2 } from '@ferry/ui';
import { useUI } from '../state/ui';

/**
 * Composer project chip. On Home it switches the project for the next chat; inside a chat the
 * project is fixed, so it offers that project's settings instead.
 */
export function WorkspaceMenu({
  workspaces,
  selectedId,
  lockedToSession = false,
}: {
  workspaces: Workspace[];
  selectedId: string | undefined;
  lockedToSession?: boolean;
}) {
  const navigate = useNavigate();
  const selected = workspaces.find((workspace) => workspace.id === selectedId);
  const openLibrary = (workspaceId?: string) => {
    if (workspaceId) localStorage.setItem('ferry.libraryWorkspace', workspaceId);
    void navigate({ to: '/library' });
  };
  return (
    <UiV2.DropdownMenu>
      <UiV2.DropdownMenuTrigger asChild>
        <button
          aria-label={`Project: ${selected?.name ?? 'Choose project'}`}
          className="v2-composer-tool"
          type="button"
        >
          <FolderOpen aria-hidden="true" />
          {selected?.name ?? 'Choose project'}
          <ChevronDown aria-hidden="true" />
        </button>
      </UiV2.DropdownMenuTrigger>
      <UiV2.DropdownMenuContent align="start" className="v2-workspace-menu" side="top">
        <UiV2.DropdownMenuLabel>
          {lockedToSession ? "This chat's project" : 'Projects'}
        </UiV2.DropdownMenuLabel>
        {(lockedToSession && selected ? [selected] : workspaces).map((workspace) => (
          <UiV2.DropdownMenuItem
            key={workspace.id}
            onSelect={() => {
              if (!lockedToSession) useUI.getState().setSelectedWorkspace(workspace.id);
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
        {lockedToSession && selected && (
          <UiV2.DropdownMenuItem
            onSelect={() => {
              openLibrary(selected.id);
            }}
          >
            <FolderCog />
            Project settings
          </UiV2.DropdownMenuItem>
        )}
        <UiV2.DropdownMenuItem
          onSelect={() => {
            openLibrary();
          }}
        >
          <FolderPlus />
          Add or manage projects…
        </UiV2.DropdownMenuItem>
      </UiV2.DropdownMenuContent>
    </UiV2.DropdownMenu>
  );
}
