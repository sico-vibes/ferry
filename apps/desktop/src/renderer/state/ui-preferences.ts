import type { UIState, UIUpdate } from './ui.types';

export function createPreferencesSlice(
  update: UIUpdate,
): Pick<
  UIState,
  'setRightTab' | 'setDensity' | 'setSettingsSection' | 'setSelectedWorkspace' | 'setExploreFilter'
> {
  return {
    setRightTab: (rightTab) => {
      update(() => ({ rightTab }));
    },
    setDensity: (density) => {
      update(() => ({ density }));
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
}
