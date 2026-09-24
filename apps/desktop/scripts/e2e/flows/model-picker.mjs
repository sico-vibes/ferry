export const name = 'model-picker';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('button', { name: 'New Chat' }).first().click();
  await page.waitForURL(/\/s\//);
  const trigger = page.getByRole('button', { name: /Auto ·/ });
  await trigger.waitFor({ timeout: 15_000 });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await ctx.expect(picker).toBeVisible();
  await ctx.expect(picker.getByText('Auto (recommended)')).toBeVisible();
  await ctx.expect(picker.locator('.model-candidate').first()).toBeAttached();
  // BUG(W1): the popover is trapped under the session content and overlaps the sidebar, so its rows
  // are not clickable (see e2e/regression.spec.ts). This flow only verifies it opens and closes.
  await page.keyboard.press('Escape');
  await ctx.expect(picker).toBeHidden({ timeout: 10_000 });
}
