import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';
import './build-web.mjs';

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
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Best Available' }),
    ).toBeVisible();
    await expect(page.getByText('Saved topics')).toBeVisible();
    await expect(page.getByRole('img', { name: /capacity remaining/i })).toBeVisible();
    const rightBefore = await page.locator('.right-panel').boundingBox();
    const resize = page.getByRole('separator', { name: 'Resize right panel' });
    const resizeBox = await resize.boundingBox();
    if (!rightBefore || !resizeBox) throw new Error('Right panel resize handle is missing');
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + 120);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x + resizeBox.width / 2 - 60, resizeBox.y + 120);
    await page.mouse.up();
    await expect
      .poll(async () => (await page.locator('.right-panel').boundingBox())?.width)
      .toBeGreaterThan(rightBefore.width + 40);
    await page
      .getByRole('textbox', { name: 'Message Ferry' })
      .fill('Switch models after quota handoff');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: /Switched.*nvidia/ })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/retry policy is now centralized/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Allow once' }).click({ timeout: 10_000 });
    await expect(page.getByText(/Checkpoint/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/full suite passed/i).last()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Open terminal panel' }).click();
    await page.locator('.xterm-helper-textarea').click();
    await page.keyboard.type('git status');
    await page.keyboard.press('Enter');
    await expect(page.getByText('working tree clean')).toBeVisible();
    const title = await page.locator('[role="tablist"] [role="tab"]').first().innerText();
    await page
      .getByRole('button', { name: `Save ${title}` })
      .first()
      .click();
    await page
      .getByRole('navigation', { name: 'Right panel tabs' })
      .getByRole('button', { name: 'Chats' })
      .click();
    await expect(page.getByText('Saved topics')).toBeVisible();
    await expect(page.getByRole('button', { name: `Unsave ${title}` }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Explore' }).click();
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Provider filters' })).toBeVisible();
    await page
      .getByRole('region', { name: 'Provider filter' })
      .getByRole('button', { name: 'Free', exact: true })
      .click();
    const gemini = page.locator('article').filter({ hasText: 'Gemini API' });
    await gemini.getByRole('button', { name: 'Test Gemini API' }).click();
    await expect(page.getByText(/Connected · \d+ ms/)).toBeVisible({ timeout: 10_000 });
    const mistral = page.locator('article').filter({ hasText: 'Mistral (Experiment)' });
    await mistral.getByRole('button', { name: 'Manage key' }).click();
    await page.getByRole('textbox', { name: 'API key' }).fill('demo-mistral-key');
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(mistral.getByText('Key: unchecked')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await mistral.getByRole('button', { name: 'Test Mistral (Experiment)' }).click();
    await expect(mistral.getByText('Key: valid')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Usage' }).click();
    await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
    const nvidiaUsage = page
      .getByRole('region', { name: 'Capacity remaining' })
      .getByRole('list')
      .locator('li')
      .filter({ hasText: 'NVIDIA NIM' });
    await expect(nvidiaUsage.getByLabel('NVIDIA NIM has no daily cap')).toHaveText('∞');
    await expect(nvidiaUsage.locator('.h-1')).toHaveCount(0);
    await page.getByRole('button', { name: 'tokens', exact: true }).click();
    await expect(
      page.getByRole('img', { name: '14 day stacked tokens usage by provider' }),
    ).toBeVisible();

    await page.goto(`${url}/onboarding`);
    await page.getByRole('button', { name: /Get started/ }).click();
    await page.getByRole('button', { name: 'Gemini API' }).click();
    await page.getByRole('button', { name: 'OpenRouter (free models)' }).click();
    await page
      .getByRole('textbox', { name: 'Gemini API API key' })
      .fill('demo-onboarding-gemini-key');
    await page.getByRole('button', { name: 'Save key' }).first().click();
    await page.getByRole('button', { name: 'Test' }).first().click();
    await expect(page.getByText('Connected')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'OpenRouter (free models) API key' })
      .fill('demo-onboarding-openrouter-key');
    await page.getByRole('button', { name: 'Save key' }).nth(1).click();
    await page.getByRole('button', { name: 'Test' }).nth(1).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: 'Build bigger with Ferry,' })).toBeVisible();

    await page.goto(`${url}/settings`);
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Profiles' })
      .click();
    await page
      .locator('.settings-content')
      .getByRole('button', { name: /Best Available/ })
      .first()
      .click();
    await page.getByRole('textbox', { name: 'Daily cap ($)' }).fill('3.5');
    await page.getByRole('textbox', { name: 'Monthly cap ($)' }).fill('25');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Profile saved: Best Available')).toBeVisible();

    await page.goto(`${url}/library`);
    await expect(page.locator('.context-sidebar-row', { hasText: 'ferry-web' })).toBeVisible();
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
