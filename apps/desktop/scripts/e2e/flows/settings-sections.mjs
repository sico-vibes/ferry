export const name = 'settings-sections';
export async function run(page, ctx) {
  await page.goto(`${ctx.url}/settings`);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  const sections = [
    ['General', 'Appearance'],
    ['Profiles', 'Select a profile to edit.'],
    ['Providers & Keys', 'Providers & Keys'],
    ['Optimizers', 'Optimizers'],
    ['Delegation', 'Merged lanes'],
    ['Permissions', 'Default mode'],
    ['Skills', 'Enable local instructions and workflows.'],
    ['MCP', 'MCP servers'],
    ['Data & Privacy', 'Data & Privacy'],
    ['About', 'Notices'],
  ];
  for (const [name, marker] of sections) {
    await nav.getByRole('button', { name, exact: true }).click();
    await ctx
      .expect(page.locator('.settings-content').getByText(marker, { exact: false }).first())
      .toBeVisible({
        timeout: 10_000,
      });
    await ctx.expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  }
}
