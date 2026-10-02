import { captureRoute } from './capture-route.mjs';
export const name = 'explore';
export const run = captureRoute({ path: '/models', heading: 'Models', file: 'models.png' });
