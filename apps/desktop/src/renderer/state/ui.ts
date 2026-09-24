import { create } from 'zustand';
import { createLayoutSlice, parsePersistedLayout } from './ui-layout';
import { createPreferencesSlice } from './ui-preferences';
import { createTabsSlice } from './ui-tabs';
import type { UIState } from './ui.types';

export { clampBottomHeight, clampRightWidth, parsePersistedLayout } from './ui-layout';
export type { Density, OpenTab, RightTab, SettingsSection } from './ui.types';

interface PersistedUI {
  tabs: UIState['tabs'];
  activeId: UIState['activeId'];
  rightTab: UIState['rightTab'];
  density: UIState['density'];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readPersisted(): Partial<PersistedUI> & Record<string, unknown> {
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

export const useUI = create<UIState>((set) => {
  const update = (fn: (state: UIState) => Partial<UIState>) => {
    set((state) => {
      const next = fn(state);
      const merged = { ...state, ...next };
      try {
        localStorage.setItem(
          'ferry.ui',
          JSON.stringify({
            tabs: merged.tabs,
            activeId: merged.activeId,
            leftCollapsed: merged.leftCollapsed,
            rightCollapsed: merged.rightCollapsed,
            rightTab: merged.rightTab,
            density: merged.density,
            rightWidth: merged.rightWidth,
            bottomOpen: merged.bottomOpen,
            bottomHeight: merged.bottomHeight,
            bottomTab: merged.bottomTab,
          }),
        );
      } catch {
        /* Storage is optional in restricted browser contexts. */
      }
      return next;
    });
  };
  return {
    tabs: Array.isArray(saved.tabs)
      ? saved.tabs.filter(
          (tab): tab is UIState['tabs'][number] =>
            isRecord(tab) && typeof tab.id === 'string' && typeof tab.title === 'string',
        )
      : [],
    activeId: typeof saved.activeId === 'string' ? saved.activeId : null,
    ...savedLayout,
    rightTab: saved.rightTab === 'plan' || saved.rightTab === 'changes' ? saved.rightTab : 'chats',
    density: saved.density === 'compact' ? 'compact' : 'comfortable',
    settingsSection: 'General',
    selectedWorkspaceId: null,
    exploreFilter: 'All',
    ...createLayoutSlice(update),
    ...createTabsSlice(update),
    ...createPreferencesSlice(update),
  };
});
