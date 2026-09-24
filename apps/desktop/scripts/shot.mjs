import { mkdir, readdir } from 'node:fs/promises';
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
const names = process.argv.slice(2);
const modules = (await readdir(join(scriptDirectory, 'shots')))
  .filter((file) => file.endsWith('.mjs') && file !== 'capture-route.mjs')
  .map((file) => import(`./shots/${file}`));
try {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const module of await Promise.all(modules)) {
      if (names.length && !names.includes(module.name)) continue;
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce',
      });
      const ctx = {
        url,
        screenshotDirectory,
        capture: (target, name) =>
          target.screenshot({ path: join(screenshotDirectory, name), fullPage: false }),
        captureScale: async (name, scale) => {
          const scaled = await browser.newPage({
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: scale,
            reducedMotion: 'reduce',
          });
          await scaled.goto(url);
          await scaled.evaluate(() => document.fonts.ready);
          await scaled.screenshot({ path: join(screenshotDirectory, name), fullPage: false });
          await scaled.close();
        },
      };
      await module.run(page, ctx);
      await page.close();
      console.log(`shot: ${module.name} OK`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
