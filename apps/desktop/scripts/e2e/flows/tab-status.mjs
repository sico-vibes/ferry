export const name = 'tab-status';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  const activeTab = () => page.locator('[role="tablist"] [role="tab"][aria-selected="true"]');
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Explain the router');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForURL(/\/s\//);
  await ctx.expect(activeTab().getByRole('img', { name: 'running' })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto(ctx.url);
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
  await page.getByRole('button', { name: 'Send' }).click();
  await ctx.expect(activeTab().getByRole('img', { name: 'Awaiting approval' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Allow once' }).click();
}
