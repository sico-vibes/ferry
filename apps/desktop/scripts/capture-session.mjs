// Open the packaged Ferry app on an isolated data dir and screenshot one session.
// Usage: node scripts/capture-session.mjs <ferryHomeDir> <sessionId> <out.png>
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = await import('@playwright/test');

const [ferryHome, sessionId, outFile] = process.argv.slice(2);
if (!ferryHome || !sessionId || !outFile)
  throw new Error('Usage: capture-session.mjs <ferryHomeDir> <sessionId> <out.png>');
// Unpackaged run: packaged builds deliberately ignore FERRY_HOME.
const exe = resolve('node_modules/electron/dist/electron.exe');
const server = createServer();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const userData = await mkdtemp(join(tmpdir(), 'ferry-capture-'));
const app = spawn(exe, [`--remote-debugging-port=${String(port)}`, resolve('.')], {
  env: { ...process.env, FERRY_E2E_USER_DATA_DIR: userData, FERRY_HOME: ferryHome },
  stdio: 'ignore',
});
try {
  let browser;
  for (let i = 0; i < 120 && !browser; i++) {
    browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${String(port)}`)
      .catch(() => undefined);
    if (!browser) await new Promise((done) => setTimeout(done, 250));
  }
  if (!browser) throw new Error('Could not connect to Ferry');
  const page = browser.contexts()[0].pages()[0];
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await page.waitForFunction(
    () => (window.ferryEngineHello?.realDomains.length ?? 0) > 0,
    undefined,
    {
      timeout: 30_000,
    },
  );
  await page.evaluate((id) => {
    window.location.hash = `#/s/${id}`;
  }, sessionId);
  await page.waitForTimeout(4000);
  const marker = page.getByText(/handed off|handoff/i).first();
  await marker.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(800);
  await page.screenshot({ path: outFile });
  console.log(
    `saved ${outFile}; handoff text visible: ${String(await marker.isVisible().catch(() => false))}`,
  );
  await browser.close();
} finally {
  app.kill();
}
