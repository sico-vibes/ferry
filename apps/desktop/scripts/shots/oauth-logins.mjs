import { captureRoute } from './capture-route.mjs';

export const name = 'oauth-logins';
export const run = captureRoute({
  path: '/explore',
  heading: 'OAuth logins',
  file: 'oauth-logins.png',
  action: async (page) => {
    await page.getByRole('heading', { name: 'OAuth logins' }).evaluate((element) => {
      element.scrollIntoView({ block: 'start' });
    });
  },
});
