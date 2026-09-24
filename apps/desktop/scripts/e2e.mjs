import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.mjs';
import './build-web.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium, expect } = await import('@playwright/test');
const directory = dirname(fileURLToPath(import.meta.url));
const { server, url } = await serveDirectory(join(directory, '..', 'out', 'web'));
const filters = process.argv.slice(2);
const modules = await Promise.all(
  (await readdir(join(directory, 'e2e', 'flows')))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => import('./e2e/flows/' + name)),
);
try {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    for (const flow of modules) {
      if (filters.length && !filters.includes(flow.name)) continue;
      await flow.run(page, { url, expect });
      console.log(`e2e: ${flow.name} OK`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
