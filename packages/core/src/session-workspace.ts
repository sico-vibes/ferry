import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SessionIdSchema,
  WorkspaceSchema,
  newId,
  type Session,
  type Workspace,
} from '@ferry/shared';
import type { FerryServices } from './services.js';
import { rpcDomainError } from './host.js';

export function scratchPath(services: FerryServices, sessionId: string): string {
  // Persisted/imported IDs are untrusted path segments.
  const id = SessionIdSchema.regex(/^[a-zA-Z0-9_-]+$/).parse(sessionId);
  return join(services.dataDir, 'scratch', id);
}

export function sessionWorkspace(services: FerryServices, session: Session): Workspace {
  if (session.workspaceId) {
    const workspace = services.workspaces.get(session.workspaceId);
    if (!workspace) throw rpcDomainError(-32044, 'not_found', 'Session workspace is unavailable');
    return workspace;
  }
  return WorkspaceSchema.parse({
    id: `scratch_${session.id}`,
    name: 'Private scratch folder',
    path: scratchPath(services, session.id),
    trusted: true,
    gitBranch: null,
    language: 'other',
    lastOpenedAt: session.updatedAt,
    settings: {
      gateCommands: [],
      instructionsFile: null,
      defaultProfileId: null,
      permissionMode: 'ask',
    },
  });
}

export async function prepareScratch(services: FerryServices, session: Session): Promise<void> {
  if (!session.workspaceId) await mkdir(scratchPath(services, session.id), { recursive: true });
}

export async function resetScratch(services: FerryServices, sessionId: string): Promise<void> {
  const source = scratchPath(services, sessionId);
  const retained = join(services.dataDir, 'scratch-retained', sessionId);
  await mkdir(retained, { recursive: true });
  try {
    await rename(source, join(retained, newId('scratch')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function removeScratch(services: FerryServices, sessionId: string): Promise<void> {
  const current = scratchPath(services, sessionId);
  await rm(current, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await rm(join(services.dataDir, 'scratch-retained', sessionId), {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}
