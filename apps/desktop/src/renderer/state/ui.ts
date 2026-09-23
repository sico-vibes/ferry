import { create } from 'zustand';
import type { SessionId } from '@ferry/shared';

export type RightTab = 'chats' | 'plan' | 'changes' | 'terminal';
export interface OpenTab {
  id: SessionId;
  title: string;
}
interface UIState {
  tabs: OpenTab[];
  activeId: SessionId | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: RightTab;
  openTab: (tab: OpenTab) => void;
  setActive: (id: SessionId) => void;
  renameTab: (id: SessionId, title: string) => void;
  closeTab: (id: SessionId) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setRightTab: (tab: RightTab) => void;
}
interface PersistedUI {
  tabs: OpenTab[];
  activeId: SessionId | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: RightTab;
}
function readPersisted(): Partial<PersistedUI> {
  try {
    const value = localStorage.getItem('ferry.ui');
    return value ? (JSON.parse(value) as Partial<PersistedUI>) : {};
  } catch {
    return {};
  }
}
const saved = typeof localStorage === 'undefined' ? {} : readPersisted();
function persist(state: UIState): void {
  try {
    localStorage.setItem(
      'ferry.ui',
      JSON.stringify({
        tabs: state.tabs,
        activeId: state.activeId,
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        rightTab: state.rightTab,
      }),
    );
  } catch {
    /* Storage is optional in restricted browser contexts. */
  }
}
export const useUI = create<UIState>((set) => {
  const update = (fn: (state: UIState) => Partial<UIState>) => {
    set((state) => {
      const next = fn(state);
      const merged = { ...state, ...next };
      persist(merged);
      return next;
    });
  };
  return {
    tabs: saved.tabs ?? [],
    activeId: saved.activeId ?? null,
    leftCollapsed: saved.leftCollapsed ?? false,
    rightCollapsed: saved.rightCollapsed ?? false,
    rightTab: saved.rightTab ?? 'chats',
    openTab: (tab) => {
      update((s) => ({
        tabs: s.tabs.some((item) => item.id === tab.id)
          ? s.tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...s.tabs, tab],
        activeId: tab.id,
      }));
    },
    setActive: (id) => {
      update(() => ({ activeId: id }));
    },
    renameTab: (id, title) => {
      update((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)) }));
    },
    closeTab: (id) => {
      update((s) => {
        const tabs = s.tabs.filter((tab) => tab.id !== id);
        return { tabs, activeId: s.activeId === id ? (tabs.at(-1)?.id ?? null) : s.activeId };
      });
    },
    toggleLeft: () => {
      update((s) => ({ leftCollapsed: !s.leftCollapsed }));
    },
    toggleRight: () => {
      update((s) => ({ rightCollapsed: !s.rightCollapsed }));
    },
    setRightTab: (rightTab) => {
      update(() => ({ rightTab }));
    },
  };
});
