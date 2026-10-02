export const name = 'model-picker';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'New chat', exact: true })
    .click();
  await page.waitForURL(/\/s\//);
  const trigger = page.getByRole('button', { name: /Auto ·/ });
  await trigger.waitFor({ timeout: 15_000 });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await ctx.expect(picker).toBeVisible();
  await ctx.expect(picker.getByText('Auto (recommended)')).toBeVisible();
  await ctx.expect(picker.getByRole('option').first()).toBeAttached();
  await picker.getByRole('option', { name: 'Auto (recommended)' }).waitFor();
  await page.keyboard.press('Escape');
  await ctx.expect(picker).toBeHidden({ timeout: 10_000 });
}
