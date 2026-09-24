import { captureRoute } from './capture-route.mjs';
export const name = 'bottom-panel';
export const run = captureRoute({
  path: '/',
  heading: 'Bottom panel',
  role: 'region',
  file: 'bottom-panel.png',
  beforeAction: true,
  action: async (page) => {
    await page.getByRole('button', { name: 'Open terminal panel' }).click();
    await page.locator('.bottom-panel').waitFor();
  },
});
