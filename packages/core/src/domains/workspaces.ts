import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceIdSchema, WorkspaceSchema, newId } from '@ferry/shared';
import type { Workspace } from '@ferry/shared';
import { gitBranch, WorkspaceJail } from '@ferry/workspace';
import { z } from 'zod';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const PathSchema = z.string().min(1);
const IdSchema = WorkspaceIdSchema;
const UpdateSchema = z.object({
  gateCommands: z.array(z.string()).optional(),
  instructionsFile: z.string().nullable().optional(),
  defaultProfileId: z.string().nullable().optional(),
  permissionMode: z.enum(['ask', 'auto_edit', 'full_auto']).optional(),
});

function language(files: string[]): Workspace['language'] {
  if (files.some((file) => file.endsWith('.ts') || file.endsWith('.tsx'))) return 'ts';
  if (files.some((file) => file.endsWith('.js') || file.endsWith('.jsx'))) return 'js';
  if (files.some((file) => file.endsWith('.py'))) return 'py';
  if (files.some((file) => file.endsWith('.go'))) return 'go';
  if (files.some((file) => file.endsWith('.rs'))) return 'rust';
  return 'other';
}

export function register(host: CoreHost, services: FerryServices): void {
  host.registerDomain('workspaces', {
    list() {
      return Promise.resolve(
        services.workspaces.list().map((workspace) => WorkspaceSchema.parse(workspace)),
      );
    },
    async open(rawPath: unknown) {
      const absolutePath = path.resolve(PathSchema.parse(rawPath));
      if (!(await stat(absolutePath)).isDirectory())
        throw rpcDomainError(-32010, 'validation', 'Workspace path must be a directory');
      const jail = new WorkspaceJail(absolutePath);
      await jail.initialize();
      const entries = await readdir(absolutePath);
      let branch: string | null = null;
      try {
        branch = (await gitBranch(jail)).current || null;
      } catch {
        // Non-git directories are valid workspaces.
      }
      let workspace = services.workspaces
        .list()
        .find((entry) => path.resolve(entry.path) === absolutePath);
      if (!workspace) {
        workspace = WorkspaceSchema.parse({
          id: newId('workspace'),
          name: path.basename(absolutePath) || absolutePath,
          path: absolutePath,
          gitBranch: branch,
          language: language(entries),
          lastOpenedAt: services.clock.now().toISOString(),
          settings: {
            gateCommands: [],
            instructionsFile: null,
            defaultProfileId: null,
            permissionMode: 'ask',
          },
        });
      } else {
        workspace = WorkspaceSchema.parse({
          ...workspace,
          gitBranch: branch,
          language: language(entries),
          lastOpenedAt: services.clock.now().toISOString(),
        });
      }
      services.workspaces.put(workspace);
      host.emit('workspace.updated', workspace);
      return workspace;
    },
    remove(rawId: unknown) {
      return Promise.resolve().then(() => {
        const id = IdSchema.parse(rawId);
        if (!services.workspaces.delete(id))
          throw rpcDomainError(-32044, 'not_found', `Workspace not found: ${id}`);
        host.emit('workspace.removed', { id });
      });
    },
    update(rawId: unknown, rawPatch: unknown) {
      return Promise.resolve().then(() => {
        const id = IdSchema.parse(rawId);
        const patch = UpdateSchema.parse(rawPatch);
        const current = services.workspaces.get(id);
        if (!current) throw rpcDomainError(-32044, 'not_found', `Workspace not found: ${id}`);
        const workspace = WorkspaceSchema.parse({
          ...current,
          settings: { ...current.settings, ...patch },
        });
        services.workspaces.put(workspace);
        host.emit('workspace.updated', workspace);
        return workspace;
      });
    },
  });
}
