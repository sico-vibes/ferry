import { captureRoute } from './capture-route.mjs';
export const name = 'onboarding';
export const run = captureRoute({
  path: '/onboarding',
  heading: 'Code with Ferry.',
  role: 'button',
  file: 'onboarding.png',
});
