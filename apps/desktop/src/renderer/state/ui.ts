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
interface PersistedLayout {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightWidth: number;
  bottomOpen: boolean;
  bottomHeight: number;
  bottomTab: 'terminal' | 'agent-log';
}
const DEFAULT_LAYOUT: PersistedLayout = {
  leftCollapsed: false,
  rightCollapsed: false,
  rightWidth: 300,
  bottomOpen: false,
  bottomHeight: 260,
  bottomTab: 'terminal',
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parsePersistedLayout(value: unknown): PersistedLayout {
  if (!isRecord(value)) return DEFAULT_LAYOUT;
  const boolKeys = ['leftCollapsed', 'rightCollapsed', 'bottomOpen'] as const;
  const numericKeys = ['rightWidth', 'bottomHeight'] as const;
  const invalidBoolean = boolKeys.some((key) => key in value && typeof value[key] !== 'boolean');
  const invalidNumber = numericKeys.some(
    (key) => key in value && (typeof value[key] !== 'number' || !Number.isFinite(value[key])),
  );
  const invalidTab =
    'bottomTab' in value && value.bottomTab !== 'terminal' && value.bottomTab !== 'agent-log';
  if (invalidBoolean || invalidNumber || invalidTab) return DEFAULT_LAYOUT;
  return {
    leftCollapsed: typeof value.leftCollapsed === 'boolean' ? value.leftCollapsed : false,
    rightCollapsed: typeof value.rightCollapsed === 'boolean' ? value.rightCollapsed : false,
    rightWidth: clampRightWidth(typeof value.rightWidth === 'number' ? value.rightWidth : 300),
    bottomOpen: typeof value.bottomOpen === 'boolean' ? value.bottomOpen : false,
    bottomHeight: clampBottomHeight(
      typeof value.bottomHeight === 'number' ? value.bottomHeight : 260,
    ),
    bottomTab: value.bottomTab === 'agent-log' ? 'agent-log' : 'terminal',
  };
}
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
  resetLayout: () => void;
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
    const parsed: unknown = value ? JSON.parse(value) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
const saved = typeof localStorage === 'undefined' ? {} : readPersisted();
const savedLayout = parsePersistedLayout(saved);
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
    ...savedLayout,
    rightTab: saved.rightTab ?? 'chats',
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
    resetLayout: () => {
      update(() => ({ ...DEFAULT_LAYOUT }));
    },
  };
});
