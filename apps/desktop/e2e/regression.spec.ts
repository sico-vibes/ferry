import { expect, test } from '@playwright/test';

// These specs are intentionally skipped (`test.fixme`) because each one reproduces a bug that is
// still present on this revision. When the bug is fixed, remove `.fixme` and the spec should pass.

test.describe('known regressions', () => {
  // BUG (P2): a persisted `ferry.ui` whose `tabs` array contains a non-object entry (e.g. `[null]`)
  // is restored verbatim; AppFrame dereferences `tab.id` while building the tab bar and the whole
  // renderer falls back to the router error boundary ("Something went wrong!").
  // Repro: localStorage.setItem('ferry.ui', '{"tabs":[null]}') then reload.
  test('recovers from a corrupted tab list in localStorage', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('ferry.ui', JSON.stringify({ tabs: [null], activeId: null }));
    });
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByText('Something went wrong!')).toHaveCount(0);
  });

  // BUG (P2): Settings → Permissions JSON-parses `ferry.permissionRules` without checking that the
  // result is an array, so a persisted object crashes the render with `rules.map is not a function`.
  // Repro: localStorage.setItem('ferry.permissionRules', '{}'), open Settings → Permissions.
  test('renders Permissions when the persisted rules are not an array', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('ferry.permissionRules', '{}');
      localStorage.setItem('ferry.ui', JSON.stringify({ settingsSection: 'Permissions' }));
    });
    await page.reload();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Permissions' })
      .click();
    await expect(page.getByText('Something went wrong!')).toHaveCount(0);
    await expect(page.getByText('Default mode')).toBeVisible();
  });

  // BUG (P3): a stale review URL (`/s/:id/review/:missingRun`) shows "Loading review…" forever;
  // the canvas cannot distinguish a pending run from a missing one.
  test('shows a not-found state for a missing review run', async ({ page }) => {
    await page.goto('/s/session_1/review/run_does_not_exist');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByText(/not found|no longer available|missing/i)).toBeVisible();
    await expect(page.getByText('Loading review…')).toHaveCount(0);
  });

  // BUG (P1): the session model picker popover shares `right: 0` with the approvals tray but is
  // anchored at the left of the canvas, so it opens leftwards over the sidebar. Most of every
  // candidate row (and its click target) sits under `.left-column`, which intercepts pointer
  // events. Verified by geometry: popover x=90..530 while `.center-column` starts at x=372.
  // Repro: open a session, click the model trigger, click any candidate row center.
  test('selects a model by clicking the candidate row', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Chat' }).first().click();
    await page.waitForURL(/\/s\//);
    await page.getByRole('button', { name: /Auto ·/ }).click();
    const picker = page.getByRole('dialog', { name: 'Choose model' });
    await expect(picker).toBeVisible();
    await picker.locator('.model-candidate:not(.auto)').first().click();
    await expect(page.getByRole('button', { name: /Manual ·/ })).toBeVisible();
  });

  // BUG (P2): closing the last open tab while a session is still running leaves the renderer on
  // the session route with zero tabs, so the visible transcript has no tab and no way back except
  // the primary rail; the run also keeps going in the background.
  test('closing the last tab returns to a tabbed state', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
    await page.getByRole('button', { name: 'Send' }).click();
    const tab = page.locator('[role="tablist"] [role="tab"]').first();
    await tab.waitFor();
    const title = await tab.innerText();
    await page.getByRole('button', { name: `Close ${title}` }).click();
    await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveCount(1);
  });
});
