import { captureRoute } from './capture-route.mjs';
export const name = 'review';
export const run = captureRoute({
  path: '/s/demo-session/review/demo-run',
  selector: '.review-canvas',
  file: 'review.png',
});
