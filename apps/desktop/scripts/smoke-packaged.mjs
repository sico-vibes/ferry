import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const packageRoot = resolve(import.meta.dirname, '..');
const executable =
  process.env.FERRY_SMOKE_EXECUTABLE ?? join(packageRoot, 'release', 'win-unpacked', 'Ferry.exe');
const cliShim =
  process.env.FERRY_SMOKE_CLI ??
  join(packageRoot, 'release', 'win-unpacked', 'resources', 'cli', 'ferry.cmd');
function runCliShim(args, options = {}) {
  const command = [cliShim, ...args]
    .map((value) => `"${String(value).replaceAll('"', '""')}"`)
    .join(' ');
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}
const cliResult = runCliShim(['--help'], { encoding: 'utf8', timeout: 15_000 });
if (cliResult.error || cliResult.status !== 0 || !cliResult.stdout?.includes('ferry'))
  throw new Error(
    `Packaged CLI smoke failed: ${cliResult.error?.message ?? cliResult.stderr ?? cliResult.status}`,
  );
console.log('Packaged CLI shim works');
const gatewayResult = runCliShim(['gateway', '--help'], { encoding: 'utf8', timeout: 15_000 });
if (
  gatewayResult.error ||
  gatewayResult.status !== 0 ||
  !gatewayResult.stdout?.includes('gateway start|stop|status')
)
  throw new Error(
    `Packaged Gateway CLI smoke failed: ${gatewayResult.error?.message ?? gatewayResult.stderr ?? gatewayResult.status}`,
  );
console.log('Packaged Gateway CLI works');
const userDataDirectory =
  process.env.FERRY_SMOKE_DATA_DIR ?? (await mkdtemp(join(tmpdir(), 'ferry-packaged-smoke-')));
const preserveSmokeData = process.env.FERRY_SMOKE_PRESERVE_DATA === 'true';
const cliDataDirectory = join(userDataDirectory, 'cli-data');
const cliStatus = runCliShim(['status', '--json', '--data-dir', cliDataDirectory], {
  encoding: 'utf8',
  timeout: 30_000,
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
    `--user-data-dir=${userDataDirectory}`,
    `--remote-debugging-port=${remoteDebuggingPort}`,
  ],
  {
    cwd: packageRoot,
    env: { ...process.env, FERRY_INSTALL_SMOKE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

let output = '';
let settled = false;
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
      if (!preserveSmokeData) await rm(userDataDirectory, { recursive: true, force: true });
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
    const handoffLines = output.split(/\r?\n/).filter((line) => line.includes('FERRY_HANDOFF'));
    console.error(
      handoffLines.length
        ? `${error.message}\nMain-process handoff trace:\n${handoffLines.join('\n')}`
        : error.message,
    );
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
            const primaryNavigation = page.getByRole('navigation', { name: 'Primary' });
            await Promise.race([
              composer.waitFor({ state: 'visible' }),
              skipSetup.waitFor({ state: 'visible' }),
            ]);
            const interactiveMs = Number((performance.now() - launchStartedAt).toFixed(1));
            console.log(`Packaged time to interactive: ${String(interactiveMs)} ms`);
            await page.waitForFunction(
              () => (window.ferryEngineHello?.realDomains.length ?? 0) > 0,
              undefined,
              { timeout: 20_000 },
            );
            const domains = await page.evaluate(() => window.ferryEngineHello?.realDomains ?? []);
            if (
              ![
                'workspaces',
                'checkpoints',
                'sessions',
                'approvals',
                'providers',
                'oauth',
                'quota',
                'models',
                'profiles',
                'settings',
                'skills',
                'mcp',
                'optimizer',
                'delegation',
                'gateway',
              ].every((domain) => domains.includes(domain))
            )
              throw new Error(`Packaged real-domain hello failed: ${JSON.stringify(domains)}`);
            console.log(`Packaged renderer hello reports ${String(domains.length)} real domains`);
            await expect(skipSetup.or(primaryNavigation).first()).toBeVisible({
              timeout: 20_000,
            });
            const firstRunOnboardingVisible = await skipSetup.isVisible();
            if (process.env.FERRY_SMOKE_SEED_DATA === 'true') {
              const fixturePath = join(userDataDirectory, 'workspace');
              await mkdir(fixturePath, { recursive: true });
              await writeFile(
                join(fixturePath, 'README.md'),
                '# Installer persistence smoke\n',
                'utf8',
              );
              const persisted = await page.evaluate(async (workspacePath) => {
                const client = window.ferryRpcClient;
                if (!client) throw new Error('RPC client unavailable for persistence check');
                const settings = await client.settings.update({ theme: 'light' });
                const workspace = await client.workspaces.open(workspacePath);
                const session = await client.sessions.create({
                  workspaceId: workspace.id,
                  title: 'Installer persistence smoke',
                });
                return { theme: settings.theme, sessionId: session.id };
              }, fixturePath);
              await writeFile(
                process.env.FERRY_SMOKE_STATE_FILE,
                JSON.stringify(persisted),
                'utf8',
              );
            }
            console.log(`Packaged app became interactive after ${String(interactiveMs)} ms`);
            // 2 s is the warm-start target (docs/PERFORMANCE.md, measured by perf:start); cold
            // CI runners exceed it, so the smoke only warns there and fails on a real regression.
            if (interactiveMs >= 2_000)
              console.warn(
                `Packaged app TTI above the 2000 ms target: ${String(interactiveMs)} ms (advisory)`,
              );
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
            console.log('Packaged renderer and real engine hello verified');
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
  void finish(new Error('Timed out waiting for packaged renderer readiness'));
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
  });
}

void waitForRendererLoad()
  .then(() => readFile(coreLogPath, 'utf8'))
  .then((log) => {
    if (!log.includes('Ferry core started'))
      throw new Error(`Packaged core log is missing startup record: ${coreLogPath}`);
    console.log('Packaged core log written');
    console.log('Packaged smoke passed');
    return finish();
  })
  .catch((error) => finish(error));
