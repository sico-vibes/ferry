export const reviewAreas = {
  shell: {
    states: [
      'home-idle',
      'sidebar-tooltip',
      'user-menu-open',
      'session-idle',
      'session-interrupted',
      'about-dialog',
      'drawer-open',
    ],
    reference: 'design/references/2026-10-04/01-titlebar-drag.png',
    references: {
      'home-idle': 'design/references/2026-10-04/06-home-composer-stats.png',
      'session-idle': 'design/references/2026-10-04/01-titlebar-drag.png',
      'sidebar-tooltip': 'design/references/2026-10-04/08-collapsed-tooltips.png',
      'user-menu-open': 'design/references/2026-10-04/02-user-menu.png',
    },
    note: 'Title bar, collapsed rail, user menu, and drawer states.',
  },
  settings: {
    states: ['settings-general', 'settings-profiles', 'settings-providers', 'settings-gateway'],
    reference: 'design/references/2026-10-04/03-settings-dialog.png',
    references: { 'settings-providers': 'design/references/2026-10-04/10-providers-table.png' },
    note: 'Settings sections and provider key management surfaces.',
  },
  models: {
    states: [
      'models-providers',
      'models-catalog',
      'models-usage',
      'model-picker-open',
      'model-picker-hover',
    ],
    reference: 'design/references/2026-10-04/07-model-picker.png',
    references: {
      'models-providers': 'design/references/2026-10-04/04-provider-cards.png',
      'model-picker-open': 'design/references/2026-10-04/07-model-picker.png',
      'model-picker-hover': 'design/references/2026-10-04/07-model-picker.png',
    },
    note: 'Provider list, model catalog, usage, picker open state, and a hovered catalog candidate. A dedicated hover details card is part of the model product lane.',
  },
  home: {
    states: ['home-idle', 'session-idle'],
    reference: 'design/references/2026-10-04/06-home-composer-stats.png',
    note: 'Home composer and the active conversation shell.',
  },
  gateway: {
    states: ['settings-gateway'],
    reference: 'design/references/2026-10-04/11-gateway-dashboard.png',
    note: 'Current Settings > Gateway configuration surface; the reference dashboard is reserved for the Gateway product lane.',
  },
};
