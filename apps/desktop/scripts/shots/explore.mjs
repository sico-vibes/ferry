import { captureRoute } from './capture-route.mjs';
export const name = 'explore';
export const run = captureRoute({ path: '/explore', heading: 'Providers', file: 'explore.png' });
