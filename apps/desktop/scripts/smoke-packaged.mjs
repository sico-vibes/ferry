import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const packageRoot = resolve(import.meta.dirname, '..');
const executable = join(packageRoot, 'release', 'win-unpacked', 'Ferry.exe');
const cliShim = join(packageRoot, 'release', 'win-unpacked', 'resources', 'cli', 'ferry.cmd');
const cliResult = spawnSync(cliShim, ['--help'], {
  encoding: 'utf8',
  shell: true,
  timeout: 15_000,
  windowsHide: true,
});
if (cliResult.error || cliResult.status !== 0 || !cliResult.stdout?.includes('ferry'))
  throw new Error(
    `Packaged CLI smoke failed: ${cliResult.error?.message ?? cliResult.stderr ?? cliResult.status}`,
  );
console.log('Packaged CLI shim works');
const gatewayResult = spawnSync(cliShim, ['gateway', '--help'], {
  encoding: 'utf8',
  shell: true,
  timeout: 15_000,
  windowsHide: true,
});
if (
  gatewayResult.error ||
  gatewayResult.status !== 0 ||
  !gatewayResult.stdout?.includes('gateway start|stop|status')
)
  throw new Error(
    `Packaged Gateway CLI smoke failed: ${gatewayResult.error?.message ?? gatewayResult.stderr ?? gatewayResult.status}`,
  );
console.log('Packaged Gateway CLI works');
const userDataDirectory = await mkdtemp(join(tmpdir(), 'ferry-packaged-smoke-'));
const cliDataDirectory = join(userDataDirectory, 'cli-data');
const cliStatus = spawnSync(cliShim, ['status', '--json', '--data-dir', cliDataDirectory], {
  encoding: 'utf8',
  shell: true,
  timeout: 30_000,
  windowsHide: true,
  env: { ...process.env, FERRY_ENGINE: '' },
});
if (cliStatus.error || cliStatus.status !== 0) {
  await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  throw new Error(
    `Packaged CLI default-engine smoke failed: ${cliStatus.error?.message ?? cliStatus.stderr ?? cliStatus.status}`,
  );
}
let cliStatusValue;
try {
  cliStatusValue = JSON.parse(cliStatus.stdout);
} catch {
  await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  throw new Error(`Packaged CLI status returned invalid JSON: ${cliStatus.stdout}`);
}
if (cliStatusValue.engine !== 'local') {
  await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  throw new Error(`Packaged CLI default engine is not local: ${JSON.stringify(cliStatusValue)}`);
}
console.log('Packaged CLI defaults to the local engine');
const coreLogPath = join(userDataDirectory, 'engine', 'logs', 'ferry.log');
const smokeStartedAt = new Date();
const portServer = createServer();
await new Promise((resolveListen, reject) => {
  portServer.once('error', reject);
  portServer.listen(0, '127.0.0.1', resolveListen);
});
const remoteDebuggingPort = portServer.address().port;
await new Promise((resolveClose, reject) =>
  portServer.close((error) => (error ? reject(error) : resolveClose())),
);

const launchStartedAt = performance.now();
const child = spawn(
  executable,
  [
    '--disable-gpu',
    '--in-process-gpu',
    '--use-gl=swiftshader',
    '--no-sandbox',
    `--remote-debugging-port=${remoteDebuggingPort}`,
  ],
  {
    cwd: packageRoot,
    env: {
      ...process.env,
      FERRY_E2E_USER_DATA_DIR: userDataDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

let output = '';
let settled = false;
let verificationStarted = false;
const finish = async (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (child.pid) {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', resolveKill);
      killer.once('exit', resolveKill);
    });
  }
  const executableLiteral = executable.replaceAll("'", "''");
  const startedAtLiteral = smokeStartedAt.toISOString();
  await new Promise((resolveKill) => {
    const cleanup = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$startedAt = [DateTimeOffset]::Parse('${startedAtLiteral}').LocalDateTime; Get-Process -Name Ferry -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${executableLiteral}' -and $_.StartTime -ge $startedAt } | Stop-Process -Force -ErrorAction SilentlyContinue`,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    cleanup.once('error', resolveKill);
    cleanup.once('exit', resolveKill);
  });
  let cleanupError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(userDataDirectory, { recursive: true, force: true });
      cleanupError = undefined;
      break;
    } catch (error) {
      cleanupError = error;
      await delay(250);
    }
  }
  if (cleanupError) {
    console.error(`Could not remove smoke data directory: ${cleanupError.message}`);
    process.exitCode = 1;
  }
  if (error) {
    console.error(error.message);
    if (output) console.error(output.trim());
    process.exitCode = 1;
  }
};

async function waitForRendererLoad() {
  const deadline = Date.now() + 60_000;
  let lastError;
  const pageErrors = [];
  while (Date.now() < deadline) {
    let browser;
    let rendererFound = false;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${remoteDebuggingPort}`, {
        timeout: 3_000,
      });
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (!page.url().startsWith('file://')) continue;
          rendererFound = true;
          page.on('console', (message) => {
            if (message.type() === 'error') pageErrors.push(message.text());
          });
          page.on('pageerror', (error) => pageErrors.push(error.message));
          await page.waitForLoadState('load', { timeout: 5_000 });
          const readyState = await page.evaluate(() => document.readyState);
          if (readyState === 'complete') {
            const composer = page.getByRole('textbox', { name: 'Message Ferry' });
            const skipSetup = page.getByRole('button', { name: 'Skip setup' });
            await Promise.race([
              composer.waitFor({ state: 'visible' }),
              skipSetup.waitFor({ state: 'visible' }),
            ]);
            const firstRunOnboardingVisible = await skipSetup.isVisible();
            const interactiveMs = Number((performance.now() - launchStartedAt).toFixed(1));
            console.log(`Packaged time to interactive: ${String(interactiveMs)} ms`);
            await page.waitForFunction(() => Boolean(window.ferryHybrid), undefined, {
              timeout: 20_000,
            });
            const domains = await page.evaluate(async () => {
              const client = window.ferryHybrid;
              if (!client) throw new Error('Packaged renderer did not connect to Ferry Core');
              const [providers, models, capacity] = await Promise.all([
                client.providers.list(),
                client.models.list(),
                client.quota.capacity(),
              ]);
              return {
                realDomains: client.getRealDomains(),
                providers: providers.length,
                modelsAreArray: Array.isArray(models),
                capacity,
              };
            });
            if (
              !['providers', 'models', 'quota'].every((domain) =>
                domains.realDomains.includes(domain),
              ) ||
              domains.providers === 0 ||
              !domains.modelsAreArray ||
              typeof domains.capacity.percentRemaining !== 'number'
            )
              throw new Error(`Packaged real-domain RPC smoke failed: ${JSON.stringify(domains)}`);
            console.log(
              `Packaged real client connected with ${String(domains.realDomains.length)} domains`,
            );
            console.log(`Packaged app became interactive after ${String(interactiveMs)} ms`);
            if (interactiveMs > 2_000)
              console.warn(`Packaged app TTI exceeded 2000 ms: ${String(interactiveMs)} ms`);
            if (interactiveMs > 10_000)
              throw new Error(`Packaged app TTI exceeded 10000 ms: ${String(interactiveMs)} ms`);
            if (firstRunOnboardingVisible) await skipSetup.click();
            try {
              await composer.waitFor({ state: 'visible' });
            } catch (error) {
              const rendererState = await page.evaluate(() => ({
                title: document.title,
                bodyText: document.body.innerText.slice(0, 2_000),
                rootMarkup: document.querySelector('#root')?.innerHTML.slice(0, 2_000) ?? '',
              }));
              throw new Error(
                `Packaged composer did not become visible: ${JSON.stringify(rendererState)}; ${error.message}`,
              );
            }
            console.log(`Packaged renderer loaded: ${page.url()}`);
            console.log('Packaged providers/quota RPC connected');
            return;
          }
        }
      }
    } catch (error) {
      if (rendererFound)
        throw new Error(
          `Packaged renderer startup failed: ${error.message}; ${pageErrors.join(' | ')}`,
        );
      lastError = error;
    } finally {
      await browser?.close().catch(() => undefined);
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for packaged renderer did-finish-load: ${lastError?.message ?? 'no page target'}`,
  );
}

const timeout = setTimeout(() => {
  void finish(new Error('Timed out waiting for FERRY_CORE_READY'));
}, 60_000);

child.once('error', (error) => void finish(error));
child.once('exit', (code) => {
  if (!settled)
    void finish(new Error(`Packaged Ferry exited before ready (code ${code ?? 'unknown'})`));
});
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    output += chunk;
    const marker = output.match(/FERRY_CORE_READY\s+(\{[^\r\n]*\})/);
    if (!marker || settled || verificationStarted) return;
    verificationStarted = true;
    try {
      const result = JSON.parse(marker[1]);
      const modules = result.selfTest?.modules ?? result.modules;
      const failures = Array.isArray(modules)
        ? modules.filter((module) => module?.ok !== true)
        : [];
      if (!Array.isArray(modules) || modules.length === 0 || failures.length > 0) {
        void finish(new Error(`Packaged module self-test failed: ${JSON.stringify(result)}`));
        return;
      }
      void waitForRendererLoad()
        .then(() => {
          return readFile(coreLogPath, 'utf8');
        })
        .then((log) => {
          if (!log.includes('Ferry core started'))
            throw new Error(`Packaged core log is missing startup record: ${coreLogPath}`);
          console.log('Packaged core log written');
          console.log(`Packaged smoke passed: ${modules.length} modules ok`);
          return finish();
        })
        .catch((error) => finish(error));
    } catch (error) {
      void finish(new Error(`Could not parse FERRY_CORE_READY: ${error.message}`));
    }
  });
}

await delay(0);
