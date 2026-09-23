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
    await page.getByRole('button', { name: 'tokens', exact: true }).click();
    await expect(
      page.getByRole('img', { name: '14 day stacked tokens usage by provider' }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
