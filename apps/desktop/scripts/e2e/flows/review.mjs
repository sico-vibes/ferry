export const name = 'review';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Delegate the adapter refactor');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Allow once' }).click();
  const review = page.getByRole('button', { name: 'Review diff' });
  await review.waitFor({ timeout: 20_000 });
  await review.click();
  await page.waitForURL(/\/review\//);
  await ctx.expect(page.getByRole('region', { name: 'Delegation review' })).toBeVisible();
  await ctx.expect(page.getByText('Gate results')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.waitForURL(/\/s\/[^/]+$/);
  await ctx.expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await ctx
    .expect(page.getByRole('img', { name: 'Completed successfully' }))
    .toBeVisible({ timeout: 2_000 });
}
