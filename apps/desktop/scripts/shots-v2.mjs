import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';

if (process.env.FERRY_SKIP_WEB_BUILD !== '1') await import('./build-web.mjs');

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = await import('@playwright/test');
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(scriptDirectory, '..');
const outputDirectory = join(packageDirectory, '..', '..', 'design', 'screenshots', 'v2');
await mkdir(outputDirectory, { recursive: true });
const hostedUrl = process.env.FERRY_E2E_URL;
const served = hostedUrl ? null : await serveDirectory(join(packageDirectory, 'out', 'web'));
const baseUrl = hostedUrl ?? served?.url;
if (!baseUrl) throw new Error('Screenshot server URL was not provided');
const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 680 },
];
const themes = ['dark', 'light'];
const states = [
  'home-idle',
  'session-idle',
  'session-streaming',
  'approval-pending',
  'drawer-open',
  'settings-general',
  'settings-profiles',
  'settings-providers',
  'settings-routing',
  'settings-optimizers',
  'settings-delegation',
  'settings-permissions',
  'settings-gateway',
  'settings-data-privacy',
  'settings-shortcuts',
  'settings-about',
  'onboarding-welcome',
  'onboarding-provider',
  'onboarding-folder',
];
const filename = (state, theme, viewport) =>
  `${state}-${theme}-${viewport.width}x${viewport.height}.png`;
const errors = [];

async function selectTheme(page, theme) {
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitemradio', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
  await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor();
  await page.evaluate(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  });
  await page.evaluate(() => document.fonts.ready);
}

async function configureTheme(page, theme) {
  await page.goto(baseUrl);
  await page.locator('.v2-app-shell').waitFor();
  await selectTheme(page, theme);
}

async function captureState(browser, state, theme, viewport) {
  const label = `${state}-${theme}-${viewport.width}x${viewport.height}`;
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await configureTheme(page, theme);

    if (state === 'home-idle') {
      await page.getByRole('textbox', { name: 'Message Ferry' }).focus();
    } else if (state.startsWith('settings-')) {
      const section = {
        'settings-general': 'General',
        'settings-profiles': 'Profiles',
        'settings-providers': 'Providers & keys',
        'settings-routing': 'Routing',
        'settings-optimizers': 'Optimizers',
        'settings-delegation': 'Delegation',
        'settings-permissions': 'Permissions',
        'settings-gateway': 'Gateway',
        'settings-data-privacy': 'Data & privacy',
        'settings-shortcuts': 'Shortcuts',
        'settings-about': 'About',
      }[state];
      await page.goto(new URL('/settings', baseUrl).href);
      await page.getByRole('navigation', { name: 'Settings sections' }).waitFor();
      await page.getByRole('button', { name: section, exact: true }).click();
    } else if (state.startsWith('onboarding-')) {
      await page.goto(new URL('/settings', baseUrl).href);
      await page.getByRole('button', { name: 'Run onboarding again' }).click();
      await page.locator('.v2-onboarding-shell').waitFor();
      if (state === 'onboarding-provider') {
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      } else if (state === 'onboarding-folder') {
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      }
    } else if (state === 'session-idle' || state === 'drawer-open') {
      await page.goto(new URL('/s/session_3', baseUrl).href);
      await page.locator('.transcript-viewport').waitFor();
      await selectTheme(page, theme);
      if (state === 'drawer-open') {
        await page.getByRole('button', { name: 'Toggle drawer' }).click();
        await page.getByRole('tablist', { name: 'Session drawer tabs' }).waitFor();
      }
    } else {
      const speed = state === 'session-streaming' ? 8 : 1;
      await page.goto(new URL(`/?speed=${String(speed)}`, baseUrl).href);
      await page.locator('.v2-app-shell').waitFor();
      await selectTheme(page, theme);
      await page.getByRole('textbox', { name: 'Message Ferry' }).fill('Fix flaky tests');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForURL(/\/s\//);
      if (state === 'session-streaming') {
        await page.getByText('Bound retry delay and add jitter', { exact: true }).waitFor();
        const thinking = page.getByRole('button', { name: 'Thinking' });
        if (await thinking.count()) await thinking.click();
        await page.getByText(/The flaky assertion comes from unbounded input/i).waitFor();
      } else {
        await page.getByRole('button', { name: 'Allow once' }).waitFor();
      }
    }

    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(outputDirectory, filename(state, theme, viewport)) });
    console.log(`Captured ${label}`);
  } catch (error) {
    errors.push(label);
    console.error(`Failed ${label}: ${error instanceof Error ? error.stack : String(error)}`);
  } finally {
    await context.close();
  }
}

try {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      for (const theme of themes) {
        for (const state of states) {
          await captureState(browser, state, theme, viewport);
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  if (served)
    await new Promise((resolve, reject) =>
      served.server.close((error) => (error ? reject(error) : resolve())),
    );
}

if (errors.length > 0) {
  console.error(
    `Failed to capture ${String(errors.length)} screenshot state(s): ${errors.join(', ')}`,
  );
  process.exitCode = 1;
}
