export const name = 'command-palette-nav';
export async function run(page, ctx) {
  await page.goto(ctx.url);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  // Navigation commands appear once you type (the idle palette shows chats, quick actions, settings).
  const runCommand = async (label) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await dialog.waitFor({ timeout: 10_000 });
    await dialog.getByRole('combobox').fill(label);
    await dialog.getByRole('option', { name: label }).click();
  };
  await runCommand('Go to Usage');
  await ctx.expect(page.getByRole('tab', { name: 'Usage', exact: true })).toBeVisible({
    timeout: 10_000,
  });

  await runCommand('Go to Settings');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await ctx.expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await ctx.expect(settings).toBeHidden();

  await runCommand('Go to Models');
  await ctx.expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
}
