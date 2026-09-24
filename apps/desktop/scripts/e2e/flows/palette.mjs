export const name = 'palette';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor({ state: 'visible' });
  await page.keyboard.press('Control+k');
  await ctx.expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
}
