export const name = 'bottom-panel';
export async function run(page, ctx) {
  await page.goto(new URL('/s/session_1', ctx.url).href);
  const drawerToggle = page.getByRole('button', { name: 'Toggle drawer' });
  if ((await drawerToggle.getAttribute('aria-expanded')) === 'true') await drawerToggle.click();
  await drawerToggle.click();
  const tabs = page.getByRole('tablist', { name: 'Session drawer tabs' });
  await tabs.getByRole('tab', { name: 'Terminal' }).click();
  await ctx.expect(page.getByRole('region', { name: 'Session tools' })).toBeVisible();
  await ctx.expect(page.getByRole('radio', { name: 'Terminal' })).toBeChecked();
  await page.getByRole('button', { name: 'Close drawer' }).click();
}
