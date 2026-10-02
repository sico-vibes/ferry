export const name = 'layout';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  const sidebarToggle = page.getByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
  if ((await sidebarToggle.getAttribute('aria-expanded')) === 'false') await sidebarToggle.click();
  await ctx.expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
  await sidebarToggle.click();
  await ctx.expect(sidebarToggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await ctx.expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true');
  await page.goto(new URL('/s/session_1', ctx.url).href);
  const drawerToggle = page.getByRole('button', { name: 'Toggle drawer' });
  if ((await drawerToggle.getAttribute('aria-expanded')) === 'true') await drawerToggle.click();
  await drawerToggle.click();
  await page.getByRole('tablist', { name: 'Session drawer tabs' }).waitFor();
  await page.getByRole('button', { name: 'Close drawer' }).click();
}
