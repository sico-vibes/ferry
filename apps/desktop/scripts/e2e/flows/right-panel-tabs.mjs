export const name = 'right-panel-tabs';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Allow once' }).click();
  await page
    .getByText(/full suite passed/i)
    .last()
    .waitFor({ timeout: 20_000 });

  const drawerToggle = page.getByRole('button', { name: 'Toggle drawer' });
  if ((await drawerToggle.getAttribute('aria-expanded')) === 'true') await drawerToggle.click();
  await drawerToggle.click();
  const tabs = page.getByRole('tablist', { name: 'Session drawer tabs' });
  await tabs.getByRole('tab', { name: 'Plan' }).click();
  await ctx
    .expect(tabs.getByRole('tab', { name: 'Plan' }))
    .toHaveAttribute('aria-selected', 'true');
  await ctx.expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await ctx.expect(page.getByText('Fix the flaky payment retry tests')).toBeVisible();

  await tabs.getByRole('tab', { name: 'Changes' }).click();
  await ctx
    .expect(tabs.getByRole('tab', { name: 'Changes' }))
    .toHaveAttribute('aria-selected', 'true');
  const change = page.getByRole('button', { name: /src\/payments\/retry\.ts/ }).first();
  await ctx.expect(change).toBeVisible();
  await change.click();
  await ctx.expect(page.locator('.diff-view')).toBeVisible();
  await page.locator('.diff-view').getByRole('button', { name: 'Close', exact: true }).click();

  await tabs.getByRole('tab', { name: 'Terminal' }).click();
  await ctx.expect(page.getByRole('region', { name: 'Session tools' })).toBeVisible();
}
