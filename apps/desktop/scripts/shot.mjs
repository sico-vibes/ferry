import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';
import './build-web.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = await import('@playwright/test');
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(scriptDirectory, '..');
const screenshotDirectory = join(packageDirectory, '..', '..', 'design', 'screenshots', 'app');
await mkdir(screenshotDirectory, { recursive: true });
const { server, url } = await serveDirectory(join(packageDirectory, 'out', 'web'));

try {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scale of [1, 1.25]) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: scale,
        reducedMotion: 'reduce',
      });
      await page.goto(url);
      await page.getByText('Saved topics').waitFor();
      await page.getByRole('main').getByRole('button', { name: 'Best Available' }).waitFor();
      await page.getByRole('img', { name: /capacity remaining/i }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(screenshotDirectory, scale === 1 ? 'home.png' : 'home@1.25.png'),
        fullPage: false,
      });
      if (scale === 1) {
        await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix the flaky tests');
        await page.getByRole('button', { name: 'Send' }).click();
        await page.getByRole('button', { name: 'Allow once' }).waitFor();
        await page
          .locator('.canvas-slot')
          .getByRole('button', { name: /Auto|Manual/ })
          .first()
          .click();
        await page.getByText('Auto (recommended)').waitFor();
        await page.screenshot({
          path: join(screenshotDirectory, 'model-picker.png'),
          fullPage: false,
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+k');
        await page.getByRole('heading', { name: 'Command palette' }).waitFor();
        await page.screenshot({ path: join(screenshotDirectory, 'palette.png'), fullPage: false });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Allow once' }).click();
        await page.getByText(/Checkpoint/).waitFor();
        await page.getByText(/No unrelated files changed/i).waitFor();
        await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached' });
        await page.screenshot({ path: join(screenshotDirectory, 'session.png'), fullPage: false });
        await page.getByRole('button', { name: 'Add tab' }).click();
        await page
          .getByRole('textbox', { name: 'Message Ferry' })
          .fill('Continue after quota handoff');
        await page.getByRole('button', { name: 'Send' }).click();
        await page.getByText(/retry policy is now centralized/i).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached' });
        await page.screenshot({
          path: join(screenshotDirectory, 'session-grouped.png'),
          fullPage: false,
        });
        await page.getByRole('button', { name: 'Add tab' }).click();
        await page
          .getByRole('textbox', { name: 'Message Ferry' })
          .fill('Delegate a refactor to Codex');
        await page.getByRole('button', { name: 'Send' }).click();
        await page.getByRole('button', { name: 'Allow once' }).last().click({ timeout: 15000 });
        await page.getByText('completed', { exact: true }).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Review diff' }).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Review diff' }).click();
        await page.getByRole('region', { name: 'Delegation review' }).waitFor();
        await page.locator('.monaco-diff-editor').waitFor({ timeout: 15000 });
        await page.screenshot({ path: join(screenshotDirectory, 'review.png'), fullPage: false });
      }
      await page.close();
    }
    const explorePage = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    await explorePage.goto(url);
    await explorePage.getByRole('button', { name: 'Explore' }).click();
    await explorePage.getByRole('heading', { name: 'Providers' }).waitFor();
    await explorePage.evaluate(() => document.fonts.ready);
    await explorePage.screenshot({
      path: join(screenshotDirectory, 'explore.png'),
      fullPage: false,
    });
    await explorePage.getByRole('button', { name: 'Usage' }).click();
    await explorePage.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
    await explorePage
      .getByRole('img', { name: '14 day stacked requests usage by provider' })
      .waitFor();
    await explorePage.screenshot({ path: join(screenshotDirectory, 'usage.png'), fullPage: false });
    await explorePage.close();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    await page.goto(`${url}/library`);
    await page.getByRole('heading', { name: 'Library' }).waitFor();
    await page.screenshot({ path: join(screenshotDirectory, 'library.png'), fullPage: false });
    await page.goto(`${url}/settings`);
    await page.getByRole('heading', { name: 'Settings' }).waitFor();
    await page.screenshot({ path: join(screenshotDirectory, 'settings.png'), fullPage: false });
    await page.locator('.settings-nav').getByRole('button', { name: 'Profiles' }).click();
    await page
      .locator('.settings-content')
      .getByRole('button', { name: /Best Available/ })
      .first()
      .click();
    await page.getByText('Tier per step kind').waitFor();
    await page.screenshot({
      path: join(screenshotDirectory, 'settings-profiles.png'),
      fullPage: false,
    });
    await page.goto(`${url}/onboarding`);
    await page.getByRole('button', { name: /Get started/ }).click();
    await page.getByRole('heading', { name: 'Choose providers' }).waitFor();
    await page.screenshot({ path: join(screenshotDirectory, 'onboarding.png'), fullPage: false });
    await page.close();
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
