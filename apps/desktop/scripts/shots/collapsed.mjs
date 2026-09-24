import { captureRoute } from './capture-route.mjs';
export const name = 'collapsed';
export const run = captureRoute({
  path: '/',
  heading: 'Message Ferry',
  role: 'textbox',
  file: 'collapsed-both.png',
  action: async (page) => {
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.getByRole('button', { name: 'Show sidebar' }).waitFor();
    await page.getByRole('button', { name: 'Collapse right panel' }).click();
    await page.getByRole('button', { name: 'Show panel' }).waitFor();
  },
});
