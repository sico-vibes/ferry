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
      return state.workspaces.map((w) => ({
        ...structuredClone(w),
        chatCount: state.sessions.filter((s) => s.workspaceId === w.id && !s.archived).length,
        lastActivityAt:
          state.sessions
            .filter((s) => s.workspaceId === w.id)
            .map((s) => s.updatedAt)
            .sort()
            .at(-1) ?? null,
      }));
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
          trusted: false,
          riskyRoot: false,
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
      for (const s of state.sessions.filter((s) => s.workspaceId === id)) {
        s.archived = true;
        s.workspaceId = null;
        deps.updateSession(s);
      }
      persist();
      syncStore();
    },
    async update(id, patch) {
      await before();
      const w = workspace(id);
      const { name, pinned, settings, ...legacySettings } = patch;
      if (name !== undefined) w.name = name;
      if (pinned !== undefined) w.pinned = pinned;
      w.settings = { ...w.settings, ...legacySettings, ...settings };
      WorkspaceSchema.parse(w);
      persist();
      return structuredClone(w);
    },
    async archiveChats(id) {
      await before();
      workspace(id);
      for (const s of state.sessions.filter((s) => s.workspaceId === id)) {
        s.archived = true;
        deps.updateSession(s);
      }
    },
    async searchFiles({ workspaceId }) {
      await before();
      workspace(workspaceId);
      return [];
    },
    async trust(id) {
      await before();
      const w = workspace(id);
      w.trusted = true;
      persist();
      return structuredClone(w);
    },
  };
}
