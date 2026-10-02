import { expect, test } from '@playwright/test';

test('the v2 home renders and Ctrl+N opens a chat', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Good morning, Jordan.' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Ferry' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix a failing test' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: /capacity remaining/i })).toBeVisible();
  await page.keyboard.press('Control+n');
  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByRole('textbox', { name: 'Message Ferry' })).toBeFocused();
});
