import {
  CheckpointDiffSchema,
  CheckpointSchema,
  CheckpointIdSchema,
  SessionIdSchema,
} from '@ferry/shared';
import { WorkspaceJail, ShadowCheckpoints } from '@ferry/workspace';
import { z } from 'zod';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const RestoreSchema = z.array(z.string()).optional();

export function register(host: CoreHost, services: FerryServices): void {
  host.registerDomain('checkpoints', {
    async list(rawSessionId: unknown) {
      const sessionId = SessionIdSchema.parse(rawSessionId);
      const checkpoints = services.checkpoints
        .list()
        .filter((checkpoint) => checkpoint.sessionId === sessionId)
        .map((checkpoint) => CheckpointSchema.parse(checkpoint));
      const output = [...checkpoints];
      const session = services.sessions.get(sessionId);
      const workspace = session ? services.workspaces.get(session.workspaceId) : undefined;
      const workspaces = services.workspaces.list();
      const candidates = session
        ? workspace
          ? [workspace]
          : []
        : workspaces.length === 1
          ? workspaces
          : [];
      for (const candidate of candidates) {
        const shadow = new ShadowCheckpoints(
          new WorkspaceJail(candidate.path),
          services.paths.home,
        );
        for (const entry of await shadow.list()) {
          if (output.some((checkpoint) => checkpoint.id === entry.id)) continue;
          const diff = await shadow.diff(entry.id);
          output.push(
            CheckpointSchema.parse({
              id: entry.id,
              sessionId,
              label: entry.message,
              createdAt: new Date(entry.timestamp * 1000).toISOString(),
              fileCount: (diff.match(/^diff --git /gm) ?? []).length,
            }),
          );
        }
      }
      return output;
    },
    async diff(rawId: unknown) {
      const id = CheckpointIdSchema.parse(rawId);
      const checkpoint = services.checkpoints.get(id);
      const session = checkpoint && services.sessions.get(checkpoint.sessionId);
      const candidates = session
        ? [services.workspaces.get(session.workspaceId)].filter(
            (workspace): workspace is NonNullable<typeof workspace> => workspace !== undefined,
          )
        : services.workspaces.list();
      for (const workspace of candidates) {
        const shadow = new ShadowCheckpoints(
          new WorkspaceJail(workspace.path),
          services.paths.home,
        );
        if (!(await shadow.list()).some((entry) => entry.id === id)) continue;
        return CheckpointDiffSchema.parse(await shadow.diff(id));
      }
      throw rpcDomainError(-32044, 'not_found', `Checkpoint not found: ${id}`);
    },
    async restore(rawId: unknown, rawOptions?: unknown) {
      const id = CheckpointIdSchema.parse(rawId);
      const paths = RestoreSchema.parse(rawOptions);
      const checkpoint = services.checkpoints.get(id);
      const session = checkpoint && services.sessions.get(checkpoint.sessionId);
      const workspaces = services.workspaces.list();
      const workspace = session ? services.workspaces.get(session.workspaceId) : workspaces[0];
      if (checkpoint && !workspace)
        throw rpcDomainError(-32044, 'not_found', 'Checkpoint workspace is unavailable');
      for (const candidate of workspace ? [workspace] : workspaces) {
        const shadow = new ShadowCheckpoints(
          new WorkspaceJail(candidate.path),
          services.paths.home,
        );
        if (!(await shadow.list()).some((entry) => entry.id === id)) continue;
        if (paths?.length) {
          for (const file of paths) await shadow.restore(id, file);
        } else await shadow.restore(id);
        return;
      }
      throw rpcDomainError(-32044, 'not_found', `Checkpoint not found: ${id}`);
    },
  });
}
