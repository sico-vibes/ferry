import type { PersistedLayout, UIState, UIUpdate } from './ui.types';

export const clampRightWidth = (width: number) => Math.min(560, Math.max(300, width));
export const clampBottomHeight = (height: number) => Math.min(480, Math.max(200, height));
export const DEFAULT_LAYOUT = {
  leftCollapsed: false,
  rightCollapsed: false,
  rightWidth: 300,
  bottomOpen: false,
  bottomHeight: 260,
  bottomTab: 'terminal' as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parsePersistedLayout(value: unknown): PersistedLayout {
  if (!isRecord(value)) return DEFAULT_LAYOUT;
  const boolKeys = ['leftCollapsed', 'rightCollapsed', 'bottomOpen'] as const;
  const numericKeys = ['rightWidth', 'bottomHeight'] as const;
  if (
    boolKeys.some((key) => key in value && typeof value[key] !== 'boolean') ||
    numericKeys.some(
      (key) => key in value && (typeof value[key] !== 'number' || !Number.isFinite(value[key])),
    ) ||
    ('bottomTab' in value && value.bottomTab !== 'terminal' && value.bottomTab !== 'agent-log')
  )
    return DEFAULT_LAYOUT;
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
export function createLayoutSlice(
  update: UIUpdate,
): Pick<
  UIState,
  | 'toggleLeft'
  | 'toggleRight'
  | 'setRightWidth'
  | 'toggleBottom'
  | 'setBottomHeight'
  | 'setBottomTab'
  | 'resetLayout'
> {
  return {
    toggleLeft: () => {
      update((state) => ({ leftCollapsed: !state.leftCollapsed }));
    },
    toggleRight: () => {
      update((state) => ({ rightCollapsed: !state.rightCollapsed }));
    },
    setRightWidth: (rightWidth) => {
      update(() => ({ rightWidth: clampRightWidth(rightWidth) }));
    },
    toggleBottom: () => {
      update((state) => ({ bottomOpen: !state.bottomOpen }));
    },
    setBottomHeight: (bottomHeight) => {
      update(() => ({ bottomHeight: clampBottomHeight(bottomHeight) }));
    },
    setBottomTab: (bottomTab) => {
      update(() => ({ bottomTab }));
    },
    resetLayout: () => {
      update(() => ({ ...DEFAULT_LAYOUT }));
    },
  };
}
