export const name = 'bottom-panel';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('button', { name: 'Open terminal panel' }).click();
  await ctx.expect(page.locator('.bottom-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Close terminal panel' }).click();
}
