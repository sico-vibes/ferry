import type { UIState, UIUpdate } from './ui.types';

export function createTabsSlice(
  update: UIUpdate,
): Pick<UIState, 'openTab' | 'setActive' | 'renameTab' | 'closeTab'> {
  return {
    openTab: (tab) => {
      update((state) => ({
        tabs: state.tabs.some((item) => item.id === tab.id)
          ? state.tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...state.tabs, tab],
        activeId: tab.id,
      }));
    },
    setActive: (activeId) => {
      update(() => ({ activeId }));
    },
    renameTab: (id, title) => {
      update((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
      }));
    },
    closeTab: (id) => {
      update((state) => {
        const tabs = state.tabs.filter((tab) => tab.id !== id);
        return {
          tabs,
          activeId: state.activeId === id ? (tabs.at(-1)?.id ?? null) : state.activeId,
        };
      });
    },
  };
}
