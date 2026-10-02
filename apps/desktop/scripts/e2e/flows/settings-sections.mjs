export const name = 'settings-sections';
export async function run(page, ctx) {
  await page.goto(new URL('/settings', ctx.url).toString());
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  const sections = [
    ['General', 'Appearance'],
    ['Profiles', 'Select a profile to edit.'],
    ['Providers & keys', 'Subscription logins'],
    ['Routing', 'Paid spending caps'],
    ['Optimizers', 'Terse level'],
    ['Delegation', 'Merged lanes'],
    ['Permissions', 'Default mode'],
    ['Gateway', 'Local API gateway'],
    ['Data & privacy', 'Integrations'],
    ['Shortcuts', 'keybindings.json'],
    ['About', 'Notices'],
  ];
  for (const [name, marker] of sections) {
    await nav.getByRole('button', { name, exact: true }).click();
    const main = page.getByRole('main').last();
    await ctx.expect(main.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await ctx.expect(main.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible();
    await ctx.expect(main.getByText(marker, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
    await ctx.expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  }
  await nav.getByRole('button', { name: 'Providers & keys', exact: true }).click();
  const manageKey = page.getByRole('button', { name: 'Manage key' }).first();
  await manageKey.click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await ctx
    .expect(
      page
        .getByRole('status')
        .filter({ hasText: /Connected|Connection failed/ })
        .first(),
    )
    .toBeVisible({ timeout: 10_000 });
}
