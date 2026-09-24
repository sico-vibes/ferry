import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executablePath = resolve(repoRoot, 'apps/desktop/release/win-unpacked/Ferry.exe');
const screenshotPath = resolve(repoRoot, 'design/screenshots/app/packaged.png');
const require = createRequire(resolve(repoRoot, 'apps/desktop/package.json'));
const { _electron: electron } = require('@playwright/test');
await access(executablePath);
await mkdir(resolve(repoRoot, 'design/screenshots/app'), { recursive: true });

const app = await electron.launch({ executablePath });
try {
  const window = await app.firstWindow();
  await window.locator('.home-canvas, .onboarding-page').first().waitFor({ timeout: 30_000 });

  const title = await window.title();
  assert.match(title, /Ferry.*\(demo\)/i, `Unexpected packaged window title: ${title}`);
  const renderedPage = await window.locator('.home-canvas, .onboarding-page').count();
  assert.ok(renderedPage > 0, 'Expected Home or onboarding to render');

  await window.screenshot({ path: screenshotPath, fullPage: true });
  process.stdout.write(`Packaged smoke passed: ${title}\nScreenshot: ${screenshotPath}\n`);
} finally {
  await app.close();
}
