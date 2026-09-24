export const name = 'light';
export async function run(page, ctx) {
  await page.goto(new URL('/settings', ctx.url).href);
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  const routes = [
    {
      path: '/',
      selector: '.home-canvas',
      role: 'textbox',
      heading: 'Message Ferry',
      file: 'light-home.png',
    },
    { path: '/s/session_1', selector: '.session-canvas', file: 'light-session.png' },
    { path: '/explore', heading: 'Providers', file: 'light-explore.png' },
    { path: '/settings', heading: 'Settings', file: 'light-settings.png' },
  ];
  for (const route of routes) {
    await page.goto(new URL(route.path, ctx.url).href);
    if (route.selector) await page.locator(route.selector).waitFor();
    if (route.heading)
      await page.getByRole(route.role ?? 'heading', { name: route.heading }).waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await ctx.capture(page, route.file);
  }
}
