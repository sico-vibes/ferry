import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';

if (process.env.FERRY_SKIP_WEB_BUILD !== '1') await import('./build-web.mjs');

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = await import('@playwright/test');
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(scriptDirectory, '..');
const screenshotDirectory = join(packageDirectory, '..', '..', 'design', 'screenshots', 'app');
await mkdir(screenshotDirectory, { recursive: true });
const hostedUrl = process.env.FERRY_E2E_URL;
const served = hostedUrl ? null : await serveDirectory(join(packageDirectory, 'out', 'web'));
const url = hostedUrl ?? served?.url;
if (!url) throw new Error('Screenshot server URL was not provided');
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
        captureScaling: async (routes, widths, scales) => {
          for (const route of routes) {
            for (const width of widths) {
              for (const scale of scales) {
                const scaled = await browser.newPage({
                  viewport: { width, height: 900 },
                  deviceScaleFactor: scale,
                  reducedMotion: 'reduce',
                });
                await scaled.goto(new URL(route, url).href);
                await scaled.locator('.app-shell').waitFor();
                await scaled.evaluate(() => document.fonts.ready);
                const routeName = route === '/' ? 'home' : route.slice(1).replaceAll('/', '-');
                await scaled.screenshot({
                  path: join(
                    screenshotDirectory,
                    `scaling-${routeName}-${width}w-${Math.round(scale * 100)}pct.png`,
                  ),
                  fullPage: false,
                });
                await scaled.close();
              }
            }
          }
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
  if (served)
    await new Promise((resolve, reject) =>
      served.server.close((error) => (error ? reject(error) : resolve())),
    );
}
