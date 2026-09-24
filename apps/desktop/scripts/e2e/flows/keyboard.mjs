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
}
