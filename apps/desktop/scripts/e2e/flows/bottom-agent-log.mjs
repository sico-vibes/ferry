export const name = 'bottom-agent-log';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Explain the router');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForURL(/\/s\//);
  await page.getByRole('button', { name: 'Open terminal panel' }).click();
  await page.getByRole('button', { name: 'Agent log' }).click();
  await ctx.expect(page.getByLabel('Agent log')).toBeVisible();
  await ctx.expect(page.locator('.agent-log-row').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Close bottom panel' }).click();
}
