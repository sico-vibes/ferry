import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';

if (process.env.FERRY_SKIP_WEB_BUILD !== '1') await import('./build-web.mjs');

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium, expect } = await import('@playwright/test');
const directory = dirname(fileURLToPath(import.meta.url));
const hostedUrl = process.env.FERRY_E2E_URL;
const served = hostedUrl ? null : await serveDirectory(join(directory, '..', 'out', 'web'));
const url = hostedUrl ?? served?.url;
if (!url) throw new Error('E2E server URL was not provided');
const filters = process.argv.slice(2);
const modules = await Promise.all(
  (await readdir(join(directory, 'e2e', 'flows')))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => import('./e2e/flows/' + name)),
);
try {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const flow of modules) {
      if (filters.length && !filters.includes(flow.name)) continue;
      const context = await browser.newContext({
        viewport: flow.viewport ?? { width: 1440, height: 900 },
      });
      try {
        const page = await context.newPage();
        const flowUrl = new URL(url);
        flowUrl.searchParams.set('speed', String(flow.speed ?? 1));
        await flow.run(page, { url: flowUrl.toString(), expect });
        console.log(`e2e: ${flow.name} OK`);
      } finally {
        await context.close();
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
