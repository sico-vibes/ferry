export const reviewAreas = {
  shell: {
    states: [
      'home-idle',
      'sidebar-tooltip',
      'user-menu-open',
      'user-menu-theme-open',
      'titlebar-collapsed',
      'confirm-dialog',
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
      'user-menu-theme-open': 'design/references/2026-10-04/02-user-menu.png',
      'titlebar-collapsed': 'design/references/2026-10-04/01-titlebar-drag.png',
      'confirm-dialog': 'design/references/2026-10-04/05-native-dialogs.png',
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
    note: 'Providers table, model catalog, usage, picker open state, and the hovered model details card.',
  },
  home: {
    states: ['home-idle', 'session-idle'],
    reference: 'design/references/2026-10-04/06-home-composer-stats.png',
    note: 'Home composer with the usage summary, and the active conversation shell.',
  },
  gateway: {
    states: ['gateway-dashboard', 'gateway-log', 'settings-gateway'],
    reference: 'design/references/2026-10-04/11-gateway-dashboard.png',
    note: 'Gateway dashboard (endpoint, setup, keys, live request log) and its Settings section.',
  },
};
