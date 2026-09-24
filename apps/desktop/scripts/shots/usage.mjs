import { captureRoute } from './capture-route.mjs';
export const name = 'usage';
export const run = captureRoute({
  path: '/explore/usage',
  heading: 'Usage',
  exact: true,
  file: 'usage.png',
});
