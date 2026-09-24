import { captureRoute } from './capture-route.mjs';
export const name = 'home';
export async function run(page, ctx) {
  await captureRoute({ path: '/', heading: 'Message Ferry', role: 'textbox', file: 'home.png' })(
    page,
    ctx,
  );
  await ctx.captureScale('home@1.25.png', 1.25);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Always show hero' }).click();
  await page.goto(new URL('/', ctx.url).href);
  await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor();
  await ctx.capture(page, 'home-hero.png');
}
