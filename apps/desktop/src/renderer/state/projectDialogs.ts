import { create } from 'zustand';
import type { WorkspaceId } from '@ferry/shared';

/** Which project's "Edit project" dialog is open (opened from the sidebar, composer or palette). */
export const useProjectDialogs = create<{
  editing: WorkspaceId | null;
  editProject: (id: WorkspaceId) => void;
  close: () => void;
}>((set) => ({
  editing: null,
  editProject: (id) => {
    set({ editing: id });
  },
  close: () => {
    set({ editing: null });
  },
}));
