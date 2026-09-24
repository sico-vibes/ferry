import type { SessionId } from '@ferry/shared';

export type RightTab = 'chats' | 'plan' | 'changes';
export type Density = 'comfortable' | 'compact';
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
  | 'Developer'
  | 'About';
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
  rightTab: RightTab;
  density: Density;
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
  setDensity: (density: Density) => void;
  setRightWidth: (width: number) => void;
  toggleBottom: () => void;
  setBottomHeight: (height: number) => void;
  setBottomTab: (tab: 'terminal' | 'agent-log') => void;
  setSettingsSection: (section: SettingsSection) => void;
  setSelectedWorkspace: (id: string | null) => void;
  setExploreFilter: (filter: UIState['exploreFilter']) => void;
  resetLayout: () => void;
}
export type UIUpdate = (fn: (state: UIState) => Partial<UIState>) => void;
