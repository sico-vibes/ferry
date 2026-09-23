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
    await expect(page.getByText('Best Available')).toBeVisible();
    await expect(page.getByText('Saved topics')).toBeVisible();
    await expect(page.getByRole('img', { name: /capacity remaining/i })).toBeVisible();
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveCount(1);
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
