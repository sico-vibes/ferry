export const name = 'command-palette-nav';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  const open = async () => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await dialog.waitFor({ timeout: 10_000 });
    return dialog;
  };
  let dialog = await open();
  await dialog.getByRole('option', { name: 'Go to Usage' }).click();
  await ctx.expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible({
    timeout: 10_000,
  });

  dialog = await open();
  await dialog.getByRole('option', { name: 'Go to Library' }).click();
  await ctx.expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

  dialog = await open();
  await dialog.getByRole('option', { name: 'Go to Settings' }).click();
  await ctx.expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  dialog = await open();
  await dialog.getByRole('option', { name: 'Go to Explore' }).click();
  await ctx.expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();

  await page.keyboard.press('Control+k');
  void dialog;
}
