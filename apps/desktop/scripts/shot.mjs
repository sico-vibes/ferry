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
      });
      await page.goto(url);
      await page.getByText('Saved topics').waitFor();
      await page.getByText('Best Available').waitFor();
      await page.getByRole('img', { name: /capacity remaining/i }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const suffix = scale === 1 ? '' : '@1.25';
      await page.screenshot({
        path: join(screenshotDirectory, `home-frame${suffix}.png`),
        fullPage: false,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
