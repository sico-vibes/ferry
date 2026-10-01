export const name = 'explore-paged';

export async function run(page, ctx) {
  await page.goto(new URL('/explore?demo=explore-perf', ctx.url).href);
  await page.locator('.app-shell').waitFor();
  await page.locator('tbody tr').first().waitFor();
  await page.getByRole('heading', { name: 'Models', exact: true }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 50);
  await ctx.capture(page, 'explore-models-paged.png');

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const modelsDisclosure = page
    .locator('summary')
    .filter({ hasText: /^Models\s+1,200$/ })
    .first();
  await modelsDisclosure.click();
  await page
    .getByRole('button', { name: /Show more models/ })
    .first()
    .click();
  await page.getByText('Performance model 0007').waitFor();
  await ctx.capture(page, 'explore-provider-models-show-more.png');
}
