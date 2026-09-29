export const name = 'keyboard';

async function tabUntil(page, predicate, description) {
  for (let i = 0; i < 100; i += 1) {
    if (await page.evaluate(predicate)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard focus did not reach ${description}`);
}

export async function run(page, { url, expect }) {
  await page.goto(new URL('/', url).href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor();
  await tabUntil(
    page,
    () => document.activeElement?.getAttribute('aria-label') === 'Message Ferry',
    'the message composer',
  );
  await expect(page.getByRole('textbox', { name: 'Message Ferry' })).toBeFocused();
  await page.keyboard.type('Delegate a bounded refactor');
  await page.keyboard.press('Enter');
  const approve = page.getByRole('button', { name: 'Allow once' });
  await expect(approve).toBeVisible({ timeout: 10_000 });
  await tabUntil(
    page,
    () => document.activeElement?.textContent?.trim() === 'Allow once',
    'the approval action',
  );
  await page.keyboard.press('Enter');
  const review = page.getByRole('button', { name: 'Review diff' });
  await expect(review).toBeVisible({ timeout: 15_000 });
  await tabUntil(
    page,
    () => document.activeElement?.textContent?.trim() === 'Review diff',
    'the review action',
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Delegation review' })).toBeVisible();

  await page.goto(new URL('/', url).href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  await tabUntil(
    page,
    () => document.activeElement?.textContent?.trim() === 'Explore',
    'Explore navigation',
  );
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/explore/);

  await page.goto(new URL('/settings', url).href, { waitUntil: 'domcontentloaded' });
  const settingsNav = page.getByRole('navigation', { name: 'Settings sections' });
  await settingsNav.waitFor();
  await tabUntil(
    page,
    () => document.activeElement?.textContent?.trim() === 'Advanced',
    'Advanced settings section',
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && getComputedStyle(active).outlineWidth !== '0px';
      }),
    )
    .toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('h1').filter({ hasText: 'Advanced' })).toBeVisible();

  await page.goto(new URL('/s/session_3', url).href, { waitUntil: 'domcontentloaded' });
  await tabUntil(
    page,
    () =>
      document.activeElement?.matches('button') &&
      (document.activeElement.textContent?.includes('Configuration') ?? false),
    'Configuration',
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Configuration' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Configuration' })).toBeHidden();

  const modelPicker = page.locator('button[aria-haspopup="dialog"]').filter({ hasText: 'Auto' });
  await expect(modelPicker).toBeVisible();
  await expect(modelPicker).toBeEnabled();
  await tabUntil(
    page,
    () =>
      document.activeElement?.matches('button') &&
      document.activeElement.getAttribute('aria-haspopup') === 'dialog' &&
      (document.activeElement.textContent?.includes('Auto') ?? false),
    'model picker',
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Choose model' }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(new URL('/?demo=exhausted', url).href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('alert').waitFor();
  await tabUntil(
    page,
    () =>
      document.activeElement?.matches('button') &&
      document.activeElement.textContent?.trim() === 'Wait',
    'the exhausted-capacity Wait action',
  );
  await page.keyboard.press('Enter');
  await expect(
    page
      .getByRole('region', { name: 'Notifications' })
      .getByText(/Retry scheduled: Groq in 12 min/),
  ).toBeVisible();
  await tabUntil(
    page,
    () =>
      document.activeElement?.matches('button') &&
      document.activeElement.textContent?.trim() === 'Add provider',
    'the exhausted-capacity Add provider action',
  );
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/explore/);
}
