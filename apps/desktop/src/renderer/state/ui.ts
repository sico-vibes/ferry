import { create } from 'zustand';
import type { SessionId } from '@ferry/shared';

export type RightTab = 'chats' | 'plan' | 'changes';
export type SettingsSection =
  | 'General'
  | 'Profiles'
  | 'Providers & Keys'
  | 'Optimizers'
  | 'Delegation'
  | 'Permissions'
  | 'Skills'
  | 'MCP'
  | 'Data & Privacy'
  | 'About';
export const clampRightWidth = (width: number) => Math.min(560, Math.max(300, width));
export const clampBottomHeight = (height: number) => Math.min(480, Math.max(200, height));
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
  rightWidth: number;
  bottomOpen: boolean;
  bottomHeight: number;
  bottomTab: 'terminal' | 'agent-log';
  settingsSection: SettingsSection;
  selectedWorkspaceId: string | null;
  exploreFilter: 'All' | 'Free' | 'Paid' | 'CLI';
  openTab: (tab: OpenTab) => void;
  setActive: (id: SessionId) => void;
  renameTab: (id: SessionId, title: string) => void;
  closeTab: (id: SessionId) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setRightTab: (tab: RightTab) => void;
  setRightWidth: (width: number) => void;
  toggleBottom: () => void;
  setBottomHeight: (height: number) => void;
  setBottomTab: (tab: 'terminal' | 'agent-log') => void;
  setSettingsSection: (section: SettingsSection) => void;
  setSelectedWorkspace: (id: string | null) => void;
  setExploreFilter: (filter: 'All' | 'Free' | 'Paid' | 'CLI') => void;
}
interface PersistedUI {
  tabs: OpenTab[];
  activeId: SessionId | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: RightTab;
  rightWidth: number;
  bottomOpen: boolean;
  bottomHeight: number;
  bottomTab: 'terminal' | 'agent-log';
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
        rightWidth: state.rightWidth,
        bottomOpen: state.bottomOpen,
        bottomHeight: state.bottomHeight,
        bottomTab: state.bottomTab,
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
    rightWidth: clampRightWidth(saved.rightWidth ?? 300),
    bottomOpen: saved.bottomOpen ?? false,
    bottomHeight: clampBottomHeight(saved.bottomHeight ?? 260),
    bottomTab: saved.bottomTab ?? 'terminal',
    settingsSection: 'General',
    selectedWorkspaceId: null,
    exploreFilter: 'All',
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
    setRightWidth: (rightWidth) => {
      update(() => ({ rightWidth: clampRightWidth(rightWidth) }));
    },
    toggleBottom: () => {
      update((s) => ({ bottomOpen: !s.bottomOpen }));
    },
    setBottomHeight: (bottomHeight) => {
      update(() => ({ bottomHeight: clampBottomHeight(bottomHeight) }));
    },
    setBottomTab: (bottomTab) => {
      update(() => ({ bottomTab }));
    },
    setSettingsSection: (settingsSection) => {
      update(() => ({ settingsSection }));
    },
    setSelectedWorkspace: (selectedWorkspaceId) => {
      update(() => ({ selectedWorkspaceId }));
    },
    setExploreFilter: (exploreFilter) => {
      update(() => ({ exploreFilter }));
    },
  };
});
