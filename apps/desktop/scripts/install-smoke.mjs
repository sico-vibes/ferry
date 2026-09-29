import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

if (process.platform !== 'win32') throw new Error('The clean-install smoke requires Windows.');

const packageRoot = resolve(import.meta.dirname, '..');
const outputDirectory = join(packageRoot, 'release');
const setupPath = join(outputDirectory, 'Ferry-Setup-0.9.0.exe');
const installDirectory = await mkdtemp(join(tmpdir(), 'ferry-install-smoke-app-'));
const profileRoot = await mkdtemp(join(tmpdir(), 'ferry-install-smoke-profile-'));
const testAppData = join(profileRoot, 'Roaming');
const userDataDirectory = join(testAppData, 'Ferry');
const retainedDataPath = join(userDataDirectory, 'install-smoke-retained.txt');
await mkdir(testAppData, { recursive: true });
const server = createServer();
let application;
let browser;
try {
  await access(setupPath);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const debuggingPort = server.address().port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );

  await new Promise((resolveInstall, reject) => {
    const installer = spawn(setupPath, ['/S', `/D=${installDirectory}`], { windowsHide: true });
    installer.once('error', reject);
    installer.once('exit', (code) =>
      code === 0
        ? resolveInstall()
        : reject(new Error(`NSIS installer exited with ${String(code)}`)),
    );
  });

  const executable = join(installDirectory, 'Ferry.exe');
  application = spawn(
    executable,
    [
      '--disable-gpu',
      '--in-process-gpu',
      '--use-gl=swiftshader',
      '--no-sandbox',
      `--remote-debugging-port=${String(debuggingPort)}`,
    ],
    {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        APPDATA: testAppData,
        FERRY_E2E_USER_DATA_DIR: userDataDirectory,
      },
    },
  );
  const deadline = Date.now() + 75_000;
  let connected = false;
  while (Date.now() < deadline && !connected) {
    if (application.exitCode !== null)
      throw new Error(`Installed Ferry exited with ${application.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(debuggingPort)}`, {
        timeout: 1_000,
      });
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          await page.waitForFunction(() => Boolean(window.ferryHybrid), undefined, {
            timeout: 1_000,
          });
          const connectedDomains = await page.evaluate(
            () => window.ferryHybrid?.getRealDomains() ?? [],
          );
          assert.ok(
            connectedDomains.includes('providers'),
            'The installed app did not connect to the real client',
          );
          connected = true;
          break;
        }
        if (connected) break;
      }
    } catch {
      await browser?.close().catch(() => undefined);
      browser = undefined;
      await delay(250);
    }
  }
  assert.ok(connected, 'Timed out waiting for the installed app real client');

  await mkdir(userDataDirectory, { recursive: true });
  await writeFile(retainedDataPath, 'keep', 'utf8');
  await browser?.close();
  browser = undefined;
  if (application.pid) {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill', ['/pid', String(application.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', resolveKill);
      killer.once('exit', resolveKill);
    });
  }
  await new Promise((resolveUninstall, reject) => {
    const uninstaller = spawn(join(installDirectory, 'Uninstall Ferry.exe'), ['/S'], {
      windowsHide: true,
    });
    uninstaller.once('error', reject);
    uninstaller.once('exit', (code) =>
      code === 0
        ? resolveUninstall()
        : reject(new Error(`NSIS uninstaller exited with ${String(code)}`)),
    );
  });
  await access(retainedDataPath);
  console.log('NSIS install smoke passed: app connected, uninstall retained user data.');
} finally {
  await browser?.close().catch(() => undefined);
  if (application?.pid && application.exitCode === null) {
    const killer = spawn('taskkill', ['/pid', String(application.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise((resolveKill) => {
      killer.once('error', resolveKill);
      killer.once('exit', resolveKill);
    });
  }
  server.close();
  await rm(installDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await rm(profileRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
