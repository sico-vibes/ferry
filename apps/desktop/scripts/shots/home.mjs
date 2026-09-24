import { captureRoute } from './capture-route.mjs';
export const name = 'home';
export async function run(page, ctx) {
  await captureRoute({ path: '/', heading: 'Message Ferry', role: 'textbox', file: 'home.png' })(
    page,
    ctx,
  );
  await ctx.captureScale('home@1.25.png', 1.25);
}
