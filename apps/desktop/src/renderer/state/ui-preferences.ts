import type { UIState, UIUpdate } from './ui.types';

export function createPreferencesSlice(
  update: UIUpdate,
): Pick<
  UIState,
  | 'setRightTab'
  | 'setDensity'
  | 'setTranscriptWidth'
  | 'setMotion'
  | 'setSettingsSection'
  | 'openSettings'
  | 'closeSettings'
  | 'setSelectedWorkspace'
  | 'setExploreFilter'
> {
  return {
    openSettings: (section) => {
      update((state) => ({
        settingsOpen: true,
        settingsSection: section ?? state.settingsSection,
      }));
    },
    closeSettings: () => {
      update(() => ({ settingsOpen: false }));
    },
    setRightTab: (rightTab) => {
      update(() => ({ rightTab }));
    },
    setDensity: (density) => {
      update(() => ({ density }));
    },
    setTranscriptWidth: (transcriptWidth) => {
      update(() => ({ transcriptWidth }));
    },
    setMotion: (motion) => {
      update(() => ({ motion }));
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
