import { captureRoute } from './capture-route.mjs';
export const name = 'library';
export const run = captureRoute({ path: '/library', heading: 'Library', file: 'library.png' });
