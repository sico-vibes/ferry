import { expect, test } from '@playwright/test';

test('the demo home frame renders and Ctrl+N opens a tab', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByText('Best Available')).toBeVisible();
  await expect(page.getByText('Saved topics')).toBeVisible();
  await expect(page.getByRole('img', { name: /capacity remaining/i })).toBeVisible();
  await page.keyboard.press('Control+n');
  await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveCount(1);
});
