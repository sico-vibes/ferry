import type { FerryClient } from '../../ferry-client.js';
import { WorkspaceSchema } from '@ferry/shared';
import type { WorkspaceId } from '@ferry/shared';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createWorkspacesDomain(
  _store: MockStore,
  deps: MockDeps,
): FerryClient['workspaces'] {
  const { state, clock, before, persist, syncStore, workspace, stringId } = deps;
  return {
    async list() {
      await before();
      return structuredClone(state.workspaces);
    },
    async open(path) {
      await before();
      let w = state.workspaces.find((x) => x.path === path);
      if (!w) {
        const segment = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
        w = WorkspaceSchema.parse({
          id: stringId<WorkspaceId>('workspace'),
          name: segment,
          path,
          gitBranch: null,
          language: 'other',
          lastOpenedAt: clock.now().toISOString(),
          settings: {
            gateCommands: [],
            instructionsFile: null,
            defaultProfileId: null,
            permissionMode: 'ask',
          },
        });
        state.workspaces.push(w);
        persist();
      }
      return structuredClone(w);
    },
    async remove(id) {
      await before();
      state.workspaces = state.workspaces.filter((w) => w.id !== id);
      state.sessions = state.sessions.filter((s) => s.workspaceId !== id);
      persist();
      syncStore();
    },
    async update(id, patch) {
      await before();
      const w = workspace(id);
      w.settings = { ...w.settings, ...patch };
      WorkspaceSchema.parse(w);
      persist();
      return structuredClone(w);
    },
  };
}
