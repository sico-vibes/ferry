import { captureRoute } from './capture-route.mjs';
export const name = 'session';
export const run = captureRoute({
  path: '/',
  heading: 'Message Ferry',
  role: 'textbox',
  file: 'session.png',
});
