import { captureRoute } from './capture-route.mjs';
export const name = 'usage';
export const run = captureRoute({
  path: '/models/usage',
  heading: 'Models',
  exact: true,
  file: 'usage.png',
});
