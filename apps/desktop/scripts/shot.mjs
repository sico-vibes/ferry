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
        await page.getByRole('button', { name: 'Open terminal panel' }).click();
        await page.locator('.xterm-helper-textarea').click();
        await page.keyboard.type('git status');
        await page.keyboard.press('Enter');
        await page.getByText('working tree clean').waitFor();
        await page.screenshot({
          path: join(screenshotDirectory, 'bottom-panel.png'),
          fullPage: false,
        });
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
    await page.locator('.context-settings-nav').getByRole('button', { name: 'Profiles' }).click();
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
    await page.goto(`${url}/library`);
    await page.getByRole('heading', { name: 'Library' }).waitFor();
    await page.evaluate(() => {
      const canvas = document.querySelector('.canvas-slot');
      if (!canvas) return;
      canvas.innerHTML = `<section class="canvas ferry-page"><header class="page-header"><div><h1>Empty, loading and error states</h1><p>Reusable feedback patterns</p></div></header><div class="grid grid-cols-3 gap-5"><div class="page-state empty-state"><span class="page-state-illustration">⌂</span><p>No workspaces yet</p><span class="page-state-cta">Open your first folder →</span></div><div class="skeleton-stack"><span class="skeleton-row"></span><span class="skeleton-row"></span><span class="skeleton-row"></span></div><div class="page-state error-state" role="alert"><span class="page-state-illustration">!</span><p>Provider probe failed</p><span class="page-state-cta">Review provider →</span></div></div></section>`;
    });
    await page.screenshot({ path: join(screenshotDirectory, 'empty-states.png'), fullPage: false });
    await page.close();
    const collapsedPage = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    await collapsedPage.goto(url);
    await collapsedPage.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
    await collapsedPage.getByRole('button', { name: 'Collapse sidebar' }).click();
    await collapsedPage.getByRole('button', { name: 'Show sidebar' }).waitFor();
    await collapsedPage.screenshot({
      path: join(screenshotDirectory, 'collapsed-left.png'),
      fullPage: false,
    });
    await collapsedPage.getByRole('button', { name: 'Collapse right panel' }).click();
    await collapsedPage.getByRole('button', { name: 'Show panel' }).waitFor();
    await collapsedPage.screenshot({
      path: join(screenshotDirectory, 'collapsed-both.png'),
      fullPage: false,
    });
    await collapsedPage.close();
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
