import { captureRoute } from './capture-route.mjs';
export const name = 'palette';
export const run = captureRoute({
  path: '/',
  heading: 'Command palette',
  role: 'dialog',
  file: 'palette.png',
  beforeAction: true,
  action: (page) => page.keyboard.press('Control+k'),
});
