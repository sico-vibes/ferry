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
        await page.getByRole('button', { name: 'Allow once' }).click();
        await page.getByText(/Checkpoint/).waitFor();
        await page.getByText(/No unrelated files changed/i).waitFor();
        await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached' });
        await page.screenshot({ path: join(screenshotDirectory, 'session.png'), fullPage: false });
      }
      await page.close();
    }
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
