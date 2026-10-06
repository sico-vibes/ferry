import type { SessionId } from '@ferry/shared';

export type RightTab = 'chats' | 'plan' | 'changes';
export type Density = 'comfortable' | 'compact';
export const settingsSections = [
  'General',
  'Profiles',
  'Providers & keys',
  'Routing',
  'Optimizers',
  'Delegation',
  'Permissions',
  'Gateway',
  'Data & privacy',
  'Storage & Cloud',
  'Shortcuts',
  'About',
] as const;
export type SettingsSection = (typeof settingsSections)[number];
export interface OpenTab {
  id: SessionId;
  title: string;
}
export interface PersistedLayout {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightWidth: number;
  bottomOpen: boolean;
  bottomHeight: number;
  bottomTab: 'terminal' | 'agent-log';
}
export interface UIState extends PersistedLayout {
  tabs: OpenTab[];
  activeId: SessionId | null;
  pendingComposerFocus: boolean;
  rightTab: RightTab;
  density: Density;
  selectedWorkspaceId: string | null;
  settingsSection: SettingsSection;
  settingsOpen: boolean;
  exploreFilter: 'All' | 'Free' | 'Needs attention' | 'Configured';
  openTab: (tab: OpenTab) => void;
  requestComposerFocus: () => void;
  consumeComposerFocus: () => void;
  setActive: (id: SessionId) => void;
  renameTab: (id: SessionId, title: string) => void;
  closeTab: (id: SessionId) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setRightTab: (tab: RightTab) => void;
  setDensity: (density: Density) => void;
  setRightWidth: (width: number) => void;
  toggleBottom: () => void;
  setBottomHeight: (height: number) => void;
  setBottomTab: (tab: 'terminal' | 'agent-log') => void;
  setSettingsSection: (section: SettingsSection) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSelectedWorkspace: (id: string | null) => void;
  setExploreFilter: (filter: UIState['exploreFilter']) => void;
  resetLayout: () => void;
}
export type UIUpdate = (fn: (state: UIState) => Partial<UIState>) => void;
