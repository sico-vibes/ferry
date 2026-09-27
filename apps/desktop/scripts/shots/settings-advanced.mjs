import { captureRoute } from './capture-route.mjs';
export const name = 'settings-advanced';
export const run = captureRoute({
  path: '/settings',
  selector: 'h1',
  file: 'settings-advanced-after.png',
  action: (page) => page.getByRole('button', { name: 'Advanced', exact: true }).click(),
  beforeAction: true,
});
