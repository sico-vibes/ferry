export const name = 'bottom-agent-log';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Explain the router');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForURL(/\/s\//);
  const drawerToggle = page.getByRole('button', { name: 'Toggle drawer' });
  if ((await drawerToggle.getAttribute('aria-expanded')) === 'true') await drawerToggle.click();
  await drawerToggle.click();
  const drawerTabs = page.getByRole('tablist', { name: 'Session drawer tabs' });
  await drawerTabs.getByRole('tab', { name: 'Terminal' }).click();
  await page.getByRole('radio', { name: 'Agent log' }).click();
  await ctx.expect(page.getByLabel('Agent log')).toBeVisible();
  await ctx.expect(page.locator('.agent-log-row').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Close drawer' }).click();
}
