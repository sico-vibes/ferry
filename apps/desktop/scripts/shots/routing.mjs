import { captureRoute } from './capture-route.mjs';

export const name = 'routing';
export const run = captureRoute({
  path: '/settings',
  heading: 'Settings',
  file: 'routing.png',
  action: (page) => page.getByRole('button', { name: 'Advanced' }).click(),
  beforeAction: true,
});
