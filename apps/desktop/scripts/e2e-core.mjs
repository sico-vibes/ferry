import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium, expect } = await import('@playwright/test');
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(scriptDirectory, '..');
const { server, url } = await serveDirectory(join(packageDirectory, 'out', 'web'));
try {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    const profileChipElement = page.locator('main button.v2-composer-chip');
    const profileChipName = await profileChipElement.getAttribute('aria-label');
    if (!profileChipName) throw new Error('Expected the composer chip to have an accessible name');
    const profileChip = page
      .getByRole('main')
      .getByRole('button', { name: profileChipName, exact: true });
    await expect(profileChip).toBeVisible();
    await profileChip.click();
    const modelPicker = page.locator('[role="dialog"][aria-label="Choose model"]');
    await expect(modelPicker).toHaveCount(1);
    await expect(modelPicker).toBeVisible();
    const modelList = modelPicker.getByRole('listbox', { name: 'Suggestions' });
    const profileGroup = modelList.locator('[cmdk-group]', {
      has: page.locator('[cmdk-group-heading]', { hasText: /^Profile$/ }),
    });
    await expect(profileGroup.getByRole('option', { name: /Best Available/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modelPicker).toHaveCount(0);
    await expect(page.getByRole('progressbar', { name: /capacity remaining/i })).toBeVisible();
    const chatRow = page.locator('.v2-chat-open[data-session-id]').first();
    const title = await chatRow.innerText();
    await chatRow.click();
    await expect(page.locator('.v2-chat-open[aria-current="page"][data-session-id]')).toHaveCount(
      1,
    );
    const drawerToggle = page.getByRole('button', { name: 'Toggle drawer' });
    if ((await drawerToggle.getAttribute('aria-expanded')) === 'true') await drawerToggle.click();
    await drawerToggle.click();
    await expect(page.getByRole('heading', { name: 'Session details' })).toBeVisible();
    await page.getByRole('button', { name: 'Close drawer' }).click();
    await expect(page.getByRole('heading', { name: 'Session details' })).toBeHidden();
    const sidebarToggle = page.getByRole('button', { name: /^(Collapse|Expand) sidebar$/ });
    if ((await sidebarToggle.getAttribute('aria-expanded')) === 'false')
      await sidebarToggle.click();
    await sidebarToggle.click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page
      .getByRole('textbox', { name: 'Message Ferry' })
      .fill('Switch models after quota handoff');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: /Switched.*nvidia/ })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/retry policy is now centralized/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Allow once' }).click({ timeout: 10_000 });
    await expect(page.getByText(/Checkpoint/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/full suite passed/i).last()).toBeVisible({ timeout: 10_000 });
    if ((await drawerToggle.getAttribute('aria-expanded')) === 'true') await drawerToggle.click();
    await drawerToggle.click();
    await page
      .getByRole('tablist', { name: 'Session drawer tabs' })
      .getByRole('tab', { name: 'Terminal' })
      .click();
    await page.locator('.xterm-helper-textarea').click();
    await page.keyboard.type('git status');
    await page.keyboard.press('Enter');
    await expect(page.getByText('working tree clean')).toBeVisible();
    const firstUnpinnedChatRow = page
      .locator('.v2-chat-row')
      .filter({ hasNot: page.getByRole('img', { name: 'Pinned', exact: true }) })
      .first();
    await expect(firstUnpinnedChatRow).toBeVisible();
    const unpinnedChatTitle = (
      await firstUnpinnedChatRow.locator('.v2-chat-open').innerText()
    ).trim();
    const pinnedChatRow = page.locator('.v2-chat-row').filter({
      has: page.getByRole('button', {
        name: `Chat actions for ${unpinnedChatTitle}`,
        exact: true,
      }),
    });
    const originalIndex = await page
      .locator('.v2-chat-row')
      .evaluateAll(
        (rows, targetTitle) =>
          rows.findIndex((row) => row.querySelector('.v2-chat-open')?.textContent === targetTitle),
        unpinnedChatTitle,
      );
    await page
      .getByRole('button', { name: `Chat actions for ${unpinnedChatTitle}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect(pinnedChatRow.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible();
    const pinnedBlockOrder = await page.locator('.v2-chat-row').evaluateAll((rows, targetTitle) => {
      const isPinned = (row) => row.querySelector('[aria-label="Pinned"]') !== null;
      return {
        targetIndex: rows.findIndex(
          (row) => row.querySelector('.v2-chat-open')?.textContent?.trim() === targetTitle,
        ),
        pinnedCount: rows.filter(isPinned).length,
        firstUnpinnedIndex: rows.findIndex((row) => !isPinned(row)),
      };
    }, unpinnedChatTitle);
    expect(pinnedBlockOrder.targetIndex).toBeLessThan(pinnedBlockOrder.pinnedCount);
    expect(pinnedBlockOrder.targetIndex).toBeLessThan(pinnedBlockOrder.firstUnpinnedIndex);
    await page
      .getByRole('button', { name: `Chat actions for ${unpinnedChatTitle}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
    await expect(pinnedChatRow.getByRole('img', { name: 'Pinned', exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator('.v2-chat-row')
          .evaluateAll(
            (rows, targetTitle) =>
              rows.findIndex(
                (row) => row.querySelector('.v2-chat-open')?.textContent === targetTitle,
              ),
            unpinnedChatTitle,
          ),
      )
      .toBe(originalIndex);
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Provider filters' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Provider filters' })
      .getByRole('button', { name: 'Free', exact: true })
      .click();
    const gemini = page.locator('article').filter({ hasText: 'Gemini API' });
    await gemini.getByRole('button', { name: 'Test Gemini API' }).click();
    await expect(page.getByText(/Connected · \d+ ms/)).toBeVisible({ timeout: 10_000 });
    const mistral = page.locator('article').filter({ hasText: 'Mistral (Experiment)' });
    await mistral.getByRole('button', { name: 'Manage key', exact: true }).click();
    await page.getByLabel('API key', { exact: true }).fill('demo-mistral-key');
    await page.getByRole('button', { name: 'Save key', exact: true }).click();
    await expect(mistral.getByText('Key unchecked')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await mistral.getByRole('button', { name: 'Test Mistral (Experiment)' }).click();
    await expect(mistral.getByText('Key valid')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('tab', { name: 'Usage', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Usage dashboard' })).toBeVisible();
    const nvidiaUsage = page
      .getByRole('region', { name: 'Capacity remaining' })
      .getByRole('list')
      .locator('li')
      .filter({ hasText: 'NVIDIA NIM' });
    await expect(nvidiaUsage.getByLabel('NVIDIA NIM: limit unknown')).toBeVisible();
    await expect(
      page.getByRole('img', { name: '14 day stacked tokens usage by provider' }),
    ).toBeVisible();

    await page.goto(`${url}/onboarding`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select Gemini API', exact: true }).check();
    await page
      .getByRole('checkbox', { name: 'Select OpenRouter (free models)', exact: true })
      .check();
    await page.getByLabel('Gemini API API key', { exact: true }).fill('demo-onboarding-gemini-key');
    await page.getByRole('button', { name: 'Save key' }).first().click();
    await page.getByRole('button', { name: 'Test Gemini API', exact: true }).click();
    await expect(page.getByText('Connected')).toBeVisible();
    await page
      .getByLabel('OpenRouter (free models) API key', { exact: true })
      .fill('demo-onboarding-openrouter-key');
    await page.getByRole('button', { name: 'Save key' }).nth(1).click();
    await page.getByRole('button', { name: 'Test OpenRouter (free models)', exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(new URL('/', url).href);

    await page.goto(`${url}/settings`);
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Profiles' })
      .click();
    await page
      .locator('.v2-settings-content')
      .getByRole('button', { name: /Best Available/ })
      .first()
      .click();
    await page.getByRole('textbox', { name: 'Daily cap ($)' }).fill('3.5');
    await page.getByRole('textbox', { name: 'Monthly cap ($)' }).fill('25');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Profile saved: Best Available')).toBeVisible();

    await page.goto(`${url}/library`);
    await page.getByRole('button', { name: 'Open project ferry-web', exact: true }).click();
    await page.getByRole('tab', { name: 'Permissions', exact: true }).click();
    await page.getByRole('button', { name: 'Approve project lanes' }).click();
    await expect(page.getByText('Project lanes approved')).toBeVisible();
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
