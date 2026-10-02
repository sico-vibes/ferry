import { captureRoute } from './capture-route.mjs';
export const name = 'bottom-panel';
export const run = captureRoute({
  path: '/s/session_1',
  heading: 'Session drawer tabs',
  role: 'tablist',
  file: 'bottom-panel.png',
  beforeAction: true,
  action: async (page) => {
    await page.getByRole('button', { name: 'Toggle drawer' }).click();
    await page
      .getByRole('tablist', { name: 'Session drawer tabs' })
      .getByRole('tab', { name: 'Terminal' })
      .click();
  },
});
