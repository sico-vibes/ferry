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
    await page.getByRole('button', { name: 'Profiles' }).click();
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
