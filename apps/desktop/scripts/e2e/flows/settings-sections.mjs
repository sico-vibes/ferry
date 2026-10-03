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
  await page.getByRole('button', { name: 'Close dialog' }).click();

  const providersSection = nav.getByRole('button', { name: 'Providers & keys', exact: true });
  await providersSection.scrollIntoViewIfNeeded();
  await providersSection.click();
  for (const viewport of [
    { width: 1024, height: 680 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const content = page.locator('.v2-settings-content');
    const initialNavBounds = await nav.boundingBox();
    const contentBounds = await content.boundingBox();
    await ctx.expect(content).toBeVisible();
    const scrollable = await content.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    );
    await ctx.expect(scrollable).toBe(true);
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await ctx.expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const finalNavBounds = await nav.boundingBox();
    const finalContentBounds = await content.boundingBox();
    await ctx.expect(finalNavBounds?.y).toBe(initialNavBounds?.y);
    await ctx.expect(finalContentBounds?.y).toBe(contentBounds?.y);
    await content.evaluate((element) => {
      element.scrollTop = 0;
    });
  }

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'windowControlsOverlay', {
      configurable: true,
      value: {
        visible: true,
        getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1300, height: 56 }),
      },
    });
  });
  await page.goto(new URL('/s/session_3', ctx.url).toString());
  const chatHeader = page.locator('.v2-chat-header');
  await ctx.expect(chatHeader).toBeVisible();
  const headerPadding = await chatHeader.evaluate(
    (element) => getComputedStyle(element).paddingRight,
  );
  await ctx.expect(headerPadding).toBe('164px');
  const actionRegion = await chatHeader
    .locator('.v2-header-actions button')
    .first()
    .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'));
  await ctx.expect(actionRegion).toBe('no-drag');

  await page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem('ferry.mock.v1') ?? '{}');
    const session = persisted.data?.sessions?.find((item) => item.id === 'session_3');
    if (!session) throw new Error('session_3 is missing from the mock fixture');
    session.status = 'interrupted';
    session.inFlight = false;
    localStorage.setItem('ferry.mock.v1', JSON.stringify(persisted));
  });
  await page.reload();
  const banner = page.locator('.session-resume-banner');
  const composer = page.locator('.v2-composer-wrap');
  await ctx.expect(banner).toBeVisible();
  const bannerBounds = await banner.boundingBox();
  const composerBounds = await composer.boundingBox();
  if (!bannerBounds || !composerBounds) throw new Error('Session column bounds are missing');
  await ctx.expect(Math.abs(bannerBounds.x - composerBounds.x)).toBeLessThanOrEqual(1);
  await ctx.expect(Math.abs(bannerBounds.width - composerBounds.width)).toBeLessThanOrEqual(1);
}
