import AxeBuilder from '@axe-core/playwright';

export const name = 'command-palette';

export async function run(page, { url, expect, capture }) {
  await page.goto(url);
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations, 'Command palette should have no axe violations').toEqual([]);
  await capture('command-palette.png');
  await dialog.getByRole('combobox').fill('> Toggle density');
  await expect(dialog.getByText(/Recent sessions/)).toHaveCount(0);
  await dialog.getByText(/Toggle density/).click();
  await page.keyboard.press('Control+k');
  await dialog.getByRole('combobox').fill('> New Chat');
  const newChatOption = dialog.getByRole('option', { name: 'New Chat', exact: true });
  await expect(newChatOption).toBeVisible();
  await newChatOption.click();
  await expect(dialog).toBeHidden();
  await page.waitForURL(/\/s\/[^/]+$/);
  const newSessionId = new URL(page.url()).pathname.match(/^\/s\/([^/]+)$/)?.[1];
  expect(newSessionId).toBeTruthy();
  const session = page.locator(`.v2-chat-open[data-session-id="${newSessionId}"]`);
  await expect(session).toHaveAttribute('aria-current', 'page');
  const composer = page.getByRole('textbox', { name: 'Message Ferry' });
  await expect(composer).toBeFocused();
  await expect(session).toBeVisible();
  const sessionTitle = (
    await page.getByRole('button', { name: 'Rename session' }).innerText()
  ).trim();
  await page.keyboard.press('Control+k');
  await dialog.getByRole('combobox').fill(sessionTitle);
  await dialog
    .getByRole('group', { name: 'Recent sessions' })
    .locator(`[cmdk-item][data-value*="${newSessionId}"]`)
    .click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/s/${newSessionId}`);
  await expect(dialog).toBeHidden();
  await page.goto(new URL('/', url).toString());
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
}
