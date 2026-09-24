export const name = 'right-panel-tabs';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Allow once' }).click();
  await page
    .getByText(/full suite passed/i)
    .last()
    .waitFor({ timeout: 20_000 });

  const tabs = page.getByRole('navigation', { name: 'Right panel tabs' });
  await tabs.getByRole('button', { name: 'Plan' }).click();
  await ctx.expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await ctx.expect(page.getByText('Fix the flaky payment retry tests')).toBeVisible();

  await tabs.getByRole('button', { name: 'Changes' }).click();
  const change = page.locator('.change-row', { hasText: 'src/payments/retry.ts' }).first();
  await ctx.expect(change).toBeVisible();
  await change.click();
  await ctx.expect(page.locator('.diff-view')).toBeVisible();
  await page.locator('.diff-view').getByRole('button', { name: 'Close' }).click();

  await tabs.getByRole('button', { name: 'Chat history' }).click();
  await ctx.expect(page.getByText('Saved topics')).toBeVisible();

  // Double-clicking the resize handle restores the default right-panel width.
  const handle = page.getByRole('separator', { name: 'Resize right panel' });
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('Right panel resize handle is missing');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - 80, handleBox.y + 120);
  await page.mouse.up();
  await handle.dblclick();
  await ctx.expect
    .poll(async () => (await page.locator('.right-panel').boundingBox())?.width ?? 0)
    .toBeLessThan(320);
}
