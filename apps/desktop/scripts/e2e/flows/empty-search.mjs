export const name = 'empty-search';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const search = palette.getByRole('combobox');
  await search.fill('zzz-no-such-chat');
  await ctx.expect(palette.getByText('No results.')).toBeVisible();
  await search.fill('');
  await ctx.expect(palette.getByRole('group', { name: 'Recent sessions' })).toBeVisible();
}
