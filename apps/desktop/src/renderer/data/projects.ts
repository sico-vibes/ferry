import type { QueryClient } from '@tanstack/react-query';
import type { FerryClient } from '@ferry/client';
import type { Workspace } from '@ferry/shared';
import { useUI } from '../state/ui';
import { keys } from './queries';

/**
 * Asks for a folder, opens it as a project and makes it the target of the next new chat.
 * Returns the project, or null when the picker was cancelled or there is no desktop host.
 */
export async function openProjectFolder(
  client: FerryClient,
  cache: QueryClient,
): Promise<Workspace | null> {
  const path = await window.ferryHost?.openFolder();
  if (!path) return null;
  const workspace = await client.workspaces.open(path);
  await cache.invalidateQueries({ queryKey: keys.workspaces });
  useUI.getState().setSelectedWorkspace(workspace.id);
  useUI.getState().requestComposerFocus();
  return workspace;
}
