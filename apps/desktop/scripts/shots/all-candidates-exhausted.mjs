import { captureRoute } from './capture-route.mjs';
export const name = 'all-candidates-exhausted';
export const run = captureRoute({
  path: '/?demo=exhausted',
  selector: '.session-error-card',
  file: 'all-candidates-exhausted-after.png',
  action: (page) =>
    page.locator('.transcript-viewport').evaluate((element) => {
      element.style.visibility = 'visible';
      element.scrollTop = element.scrollHeight;
    }),
  beforeAction: true,
});
