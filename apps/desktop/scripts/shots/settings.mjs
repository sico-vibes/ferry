import { captureRoute } from './capture-route.mjs';
export const name = 'settings';
export const run = captureRoute({ path: '/settings', heading: 'Settings', file: 'settings.png' });
