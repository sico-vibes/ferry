export const name = 'approvals-tray';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 20_000 });
  const bell = page.getByRole('button', { name: /Approvals/ });
  await bell.click();
  const tray = page.getByRole('dialog', { name: 'Pending approvals' });
  await ctx.expect(tray).toBeVisible();
  await ctx.expect(tray.getByText('Fix the flaky tests')).toBeVisible();
  await tray.getByRole('button', { name: 'Deny' }).click();
  await ctx.expect(tray.getByText('No pending approvals')).toBeVisible({ timeout: 15_000 });
  await tray.getByRole('button', { name: 'Close approvals' }).click();
  await ctx.expect(page.getByText('denied · resolved')).toBeVisible({ timeout: 15_000 });
}
