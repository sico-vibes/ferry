export const name = 'empty-search';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Search chats' }).fill('zzz-no-such-chat');
  await ctx.expect(page.getByText('No chats match that search.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await ctx.expect(page.getByText('Saved topics')).toBeVisible();
}
