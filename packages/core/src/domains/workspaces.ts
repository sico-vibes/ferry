import { readdir, realpath, stat } from 'node:fs/promises';
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
      let absolutePath = path.resolve(PathSchema.parse(rawPath));
      try {
        if (!(await stat(absolutePath)).isDirectory())
          throw rpcDomainError(-32010, 'validation', 'Workspace path must be a directory');
        absolutePath = await realpath(absolutePath);
      } catch (error) {
        if (error instanceof Error && 'kind' in error) throw error;
        const mapped = mapWorkspaceFsError(error);
        if (mapped) throw mapped;
        throw error;
      }
      const jail = new WorkspaceJail(absolutePath);
      let entries: string[];
      try {
        await jail.initialize();
        entries = await readdir(absolutePath);
      } catch (error) {
        const mapped = mapWorkspaceFsError(error);
        if (mapped) throw mapped;
        throw error;
      }
      let branch: string | null = null;
      try {
        branch = (await gitBranch(jail)).current || null;
      } catch {
        // Non-git directories are valid workspaces.
      }
      let workspace = services.workspaces
        .list()
        .find((entry) => workspacePathKey(entry.path) === workspacePathKey(absolutePath));
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

function workspacePathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function mapWorkspaceFsError(error: unknown): (Error & { code: number; kind: string }) | undefined {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return rpcDomainError(-32044, 'not_found', 'Workspace path does not exist');
  if (code === 'EACCES' || code === 'EPERM')
    return rpcDomainError(-32043, 'permission_denied', 'Workspace path cannot be accessed');
  if (code === 'EINVAL' || code === 'ELOOP' || code === 'ENAMETOOLONG')
    return rpcDomainError(-32010, 'validation', 'Workspace path is not valid');
  if (code.startsWith('E'))
    return rpcDomainError(-32050, 'unavailable', 'Workspace path could not be accessed');
  return undefined;
}
