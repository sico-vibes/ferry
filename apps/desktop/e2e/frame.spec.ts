import { expect, test } from '@playwright/test';

test('the v2 home renders and Ctrl+N opens a chat', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Jordan\.$/ }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Ferry' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Usage summary' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: /capacity remaining/i })).toBeVisible();
  await page.keyboard.press('Control+n');
  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByRole('textbox', { name: 'Message Ferry' })).toBeFocused();
});

test('the overlay drawer body stays inside the drawer bounds', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  await page.goto('/s/session_3');
  await page.getByRole('button', { name: 'Toggle drawer' }).click();

  const drawer = page.locator('.v2-drawer-content');
  const body = drawer.locator('.v2-drawer-body > .right-panel');
  await expect(body).toBeVisible();

  const bounds = await page.evaluate(() => {
    const drawerElement = document.querySelector('.v2-drawer-content');
    const bodyElement = document.querySelector('.v2-drawer-body');
    if (!(drawerElement instanceof HTMLElement) || !(bodyElement instanceof HTMLElement)) {
      throw new Error('Expected the session drawer and its body');
    }
    const drawerRect = drawerElement.getBoundingClientRect();
    const bodyRect = bodyElement.getBoundingClientRect();
    return {
      drawer: {
        left: drawerRect.left,
        right: drawerRect.right,
        top: drawerRect.top,
        bottom: drawerRect.bottom,
      },
      body: {
        left: bodyRect.left,
        right: bodyRect.right,
        top: bodyRect.top,
        bottom: bodyRect.bottom,
      },
    };
  });

  expect(bounds.body.left).toBeGreaterThanOrEqual(bounds.drawer.left);
  expect(bounds.body.right).toBeLessThanOrEqual(bounds.drawer.right);
  expect(bounds.body.top).toBeGreaterThanOrEqual(bounds.drawer.top);
  expect(bounds.body.bottom).toBeLessThanOrEqual(bounds.drawer.bottom);
});
