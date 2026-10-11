import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const packageRoot = resolve(import.meta.dirname, '..');
// Every CLI child inherits isolation too, including daemon start/stop before GUI launch.
if (
  !process.env.FERRY_KEYRING_SERVICE ||
  process.env.FERRY_KEYRING_SERVICE.trim().toLowerCase() === 'ferry'
)
  process.env.FERRY_KEYRING_SERVICE = `Ferry-Packaged-Smoke-${process.pid}`;
const executable =
  process.env.FERRY_SMOKE_EXECUTABLE ?? join(packageRoot, 'release', 'win-unpacked', 'Ferry.exe');
const iconMetadata = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-Item -LiteralPath $env:FERRY_SMOKE_EXECUTABLE).VersionInfo.ProductName',
  ],
  {
    encoding: 'utf8',
    env: { ...process.env, FERRY_SMOKE_EXECUTABLE: executable },
    windowsHide: true,
    timeout: 15_000,
  },
);
if (iconMetadata.error || iconMetadata.status !== 0 || iconMetadata.stdout?.trim() !== 'Ferry')
  throw new Error(
    `Packaged executable metadata smoke failed: ${iconMetadata.error?.message ?? iconMetadata.stderr ?? iconMetadata.stdout ?? iconMetadata.status}`,
  );
console.log('Packaged executable ProductName is Ferry');
const installationDirectory = dirname(executable);
const cliShim =
  process.env.FERRY_SMOKE_CLI ?? join(installationDirectory, 'resources', 'cli', 'ferry.cmd');
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
async function treeMetrics(directory) {
  let count = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { count, bytes };
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await treeMetrics(path);
      count += nested.count;
      bytes += nested.bytes;
    } else {
      count += 1;
      bytes += (await stat(path)).size;
    }
  }
  return { count, bytes };
}
function assertCliSuccess(label, result) {
  if (!result.error && result.status === 0) return;
  const details = [
    result.error?.message,
    result.stderr,
    result.stdout,
    `exit status: ${String(result.status)}`,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  throw new Error(`${label} failed:\n${details.join('\n')}`);
}
function parseCliJson(label, result) {
  assertCliSuccess(label, result);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${result.stdout}`);
  }
}

const resourcesDirectory = join(installationDirectory, 'resources');
const cliRuntimeDirectory = join(resourcesDirectory, 'cli');
const cliRuntimeMetrics = await treeMetrics(cliRuntimeDirectory);
console.log(`Packaged resources/cli files: ${String(cliRuntimeMetrics.count)}`);
if (cliRuntimeMetrics.count >= 50)
  throw new Error(
    `Packaged resources/cli has ${String(cliRuntimeMetrics.count)} files; budget is under 50.`,
  );
const installedMetrics = await treeMetrics(installationDirectory);
const unpackedMetrics = await treeMetrics(join(resourcesDirectory, 'app.asar.unpacked'));
const localeMetrics = await treeMetrics(join(installationDirectory, 'locales'));
const asarStats = await stat(join(resourcesDirectory, 'app.asar')).catch(() => ({ size: 0 }));
console.log(
  `Packaged installed files: ${String(installedMetrics.count)}; app.asar: ${String(asarStats.size)} bytes; app.asar.unpacked: ${String(unpackedMetrics.count)} files / ${String(unpackedMetrics.bytes)} bytes; locales: ${String(localeMetrics.count)} files / ${String(localeMetrics.bytes)} bytes`,
);
const cliResult = runCliShim(['--help'], { encoding: 'utf8', timeout: 15_000 });
assertCliSuccess('Packaged CLI smoke', cliResult);
if (!cliResult.stdout?.includes('ferry'))
  throw new Error(`Packaged CLI help output did not mention Ferry:\n${cliResult.stdout}`);
console.log('Packaged CLI shim works');
const versionResult = runCliShim(['--version'], { encoding: 'utf8', timeout: 15_000 });
assertCliSuccess('Packaged CLI version', versionResult);
if (!/\d+\.\d+\.\d+/.test(versionResult.stdout))
  throw new Error(`Packaged CLI version output was unexpected: ${versionResult.stdout}`);
console.log('Packaged CLI version works');
const gatewayResult = runCliShim(['gateway', '--help'], { encoding: 'utf8', timeout: 15_000 });
assertCliSuccess('Packaged Gateway CLI smoke', gatewayResult);
if (!gatewayResult.stdout?.includes('gateway start|stop|status'))
  throw new Error(`Packaged Gateway CLI help output was unexpected:\n${gatewayResult.stdout}`);
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
  assertCliSuccess('Packaged CLI default-engine smoke', cliStatus);
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
const providersResult = runCliShim(
  ['providers', 'list', '--json', '--data-dir', cliDataDirectory],
  { encoding: 'utf8', timeout: 30_000 },
);
if (!Array.isArray(parseCliJson('Packaged providers list', providersResult)))
  throw new Error('Packaged providers list did not return an array');
console.log('Packaged providers list works');
const doctorResult = runCliShim(['doctor', '--json', '--data-dir', cliDataDirectory], {
  encoding: 'utf8',
  timeout: 30_000,
  // This gate certifies bundled modules, not unrelated globally installed agent launchers.
  env: { ...process.env, PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') },
});
const doctorRows = parseCliJson('Packaged doctor', doctorResult);
for (const required of ['SQLite', 'keyring', 'pty', 'ripgrep']) {
  const row = doctorRows.find((candidate) => candidate.name === required);
  if (!row || row.status !== 'ok')
    throw new Error(
      'Packaged doctor ' + required + ' check was not healthy: ' + (row?.reason ?? 'row missing'),
    );
}
const ripgrepRow = doctorRows.find((row) => row.name === 'ripgrep');
if (!ripgrepRow?.reason.toLowerCase().includes(installationDirectory.toLowerCase()))
  throw new Error(
    'Packaged ripgrep path was not resolved from the copied installation: ' +
      (ripgrepRow?.reason ?? 'row missing'),
  );
console.log('Packaged doctor loads native modules');
const runResult = runCliShim(
  [
    'run',
    'Packaged CLI streaming smoke',
    '--engine',
    'mock',
    '--json',
    '--max-steps',
    '16',
    '--data-dir',
    cliDataDirectory,
  ],
  { encoding: 'utf8', timeout: 60_000 },
);
assertCliSuccess('Packaged CLI streaming run', runResult);
const streamEvents = runResult.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (!streamEvents.some((event) => event.type === 'session.delta' || event.type === 'session.part'))
  throw new Error('Packaged CLI run emitted no streaming events: ' + runResult.stdout);
if (
  !streamEvents.some((event) => event.type === 'session.status' && event.session?.status === 'idle')
)
  throw new Error('Packaged CLI mock run did not emit a successful terminal idle status.');
console.log('Packaged CLI run streams to an idle terminal status');
// Keep daemon smoke listeners separate from any real Ferry Gateway on the default port.
const Database = createRequire(join(packageRoot, 'package.json'))('better-sqlite3');
const daemonSettingsDb = new Database(join(cliDataDirectory, 'db', 'ferry.sqlite'));
try {
  daemonSettingsDb
    .prepare('INSERT OR REPLACE INTO settings_kv(key,value_json,updated_at) VALUES (?,?,?)')
    .run(
      'gateway-settings',
      JSON.stringify({ enabled: false, port: 0, allowLan: false }),
      new Date().toISOString(),
    );
} finally {
  daemonSettingsDb.close();
}
await writeFile(
  join(cliDataDirectory, 'core.lock'),
  JSON.stringify({ pid: 2147483647, protocol: 'ferry/1' }),
  'utf8',
);
await writeFile(
  join(cliDataDirectory, 'gateway-status.json'),
  JSON.stringify({ pid: 2147483647, url: 'http://127.0.0.1:1', port: 1, host: '127.0.0.1' }),
  'utf8',
);
const gatewayStartResult = runCliShim(
  ['gateway', 'start', '--json', '--data-dir', cliDataDirectory],
  { encoding: 'utf8', timeout: 45_000 },
);
const gatewayStart = parseCliJson('Packaged Gateway start', gatewayStartResult);
if (typeof gatewayStart.url !== 'string')
  throw new Error(`Packaged Gateway start did not return a URL: ${gatewayStartResult.stdout}`);
try {
  const gatewayStatusResult = runCliShim(
    ['gateway', 'status', '--json', '--data-dir', cliDataDirectory],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const gatewayStatus = parseCliJson('Packaged Gateway status', gatewayStatusResult);
  if (gatewayStatus.running !== true)
    throw new Error(`Packaged Gateway did not report running: ${gatewayStatusResult.stdout}`);
  console.log('Packaged Gateway starts and reports status');
} finally {
  const gatewayStopResult = runCliShim(
    ['gateway', 'stop', '--json', '--data-dir', cliDataDirectory],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assertCliSuccess('Packaged Gateway stop cleanup', gatewayStopResult);
}
const restarted = parseCliJson(
  'Packaged Gateway restart',
  runCliShim(['gateway', 'start', '--json', '--data-dir', cliDataDirectory], {
    encoding: 'utf8',
    timeout: 45_000,
  }),
);
if (!restarted.url) throw new Error('Gateway restart did not return its endpoint');
assertCliSuccess(
  'Packaged Gateway restart cleanup',
  runCliShim(['gateway', 'stop', '--json', '--data-dir', cliDataDirectory], {
    encoding: 'utf8',
    timeout: 30_000,
  }),
);
console.log('Packaged Gateway recovers stale locks, stops and restarts');
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
    env: {
      ...process.env,
      FERRY_INSTALL_SMOKE: 'true',
      FERRY_E2E_USER_DATA_DIR: userDataDirectory,
      FERRY_DATA_DIR: join(userDataDirectory, 'engine'),
    },
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
            const skipSetup = page.getByRole('heading', {
              name: 'What will you use Ferry for?',
              exact: true,
            });
            const primaryNavigation = page.getByRole('navigation', { name: 'Primary' });
            // After an upgrade, What's new opens once over the app; close it like a user would.
            const whatsNew = page.getByRole('dialog', { name: /What.s new/ });
            await Promise.race([
              composer.waitFor({ state: 'visible' }),
              skipSetup.waitFor({ state: 'visible' }),
              whatsNew.waitFor({ state: 'visible' }),
            ]);
            if (await whatsNew.isVisible()) {
              await page.keyboard.press('Escape');
              await whatsNew.waitFor({ state: 'hidden' });
              await Promise.race([
                composer.waitFor({ state: 'visible' }),
                skipSetup.waitFor({ state: 'visible' }),
              ]);
            }
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
            const beforeAttach = JSON.parse(
              await readFile(join(userDataDirectory, 'engine', 'core.lock'), 'utf8'),
            );
            const attachedStatusResult = runCliShim(['status', '--json'], {
              encoding: 'utf8',
              timeout: 30_000,
              env: {
                ...process.env,
                FERRY_ENGINE: '',
                FERRY_DATA_DIR: join(userDataDirectory, 'engine'),
              },
            });
            const attachedStatus = parseCliJson(
              'Packaged CLI status over the running app control channel',
              attachedStatusResult,
            );
            if (attachedStatus.engine !== 'local')
              throw new Error(
                `Packaged CLI did not report the running local engine: ${attachedStatusResult.stdout}`,
              );
            const attachedProvidersResult = runCliShim(['providers', 'list', '--json'], {
              encoding: 'utf8',
              timeout: 30_000,
              env: {
                ...process.env,
                FERRY_ENGINE: '',
                FERRY_DATA_DIR: join(userDataDirectory, 'engine'),
              },
            });
            if (
              !Array.isArray(
                parseCliJson('Packaged providers via app control channel', attachedProvidersResult),
              )
            )
              throw new Error(
                'Packaged providers over the app control channel did not return an array',
              );
            console.log('Packaged CLI attaches to the running app core');
            const afterAttach = JSON.parse(
              await readFile(join(userDataDirectory, 'engine', 'core.lock'), 'utf8'),
            );
            if (afterAttach.pid !== beforeAttach.pid)
              throw new Error('Desktop/CLI did not preserve the single Core owner');
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
                await client.workspaces.trust(workspace.id);
                const session = await client.sessions.create({
                  workspaceId: workspace.id,
                  title: 'Installer persistence smoke',
                });
                // Core deliberately prunes unused empty chats on restart. Seed a durable
                // user message with every provider disabled, so no generation can dispatch.
                for (const provider of await client.providers.list())
                  if (provider.enabled) await client.providers.setEnabled(provider.id, false);
                await client.sessions.send(session.id, { text: 'Installer persistence sentinel' });
                if (!(await client.sessions.get(session.id)).messages.length)
                  throw new Error('Persistence fixture did not record its synthetic user message');
                const base = (await client.profiles.list()).find(
                  (profile) => profile.name === 'Auto-Free',
                );
                if (!base) throw new Error('Missing Auto-Free profile');
                const profile = await client.profiles.save({
                  ...base,
                  id: 'install-smoke-routing',
                  name: 'Installer routing',
                  builtin: false,
                  routingObjective: 'latency',
                });
                const key = await client.gateway.createKey({
                  name: 'Installer key',
                  profile: profile.id,
                });
                return {
                  theme: settings.theme,
                  sessionId: session.id,
                  profileId: profile.id,
                  keyId: key.key.id,
                };
              }, fixturePath);
              await writeFile(
                process.env.FERRY_SMOKE_STATE_FILE,
                JSON.stringify(persisted),
                'utf8',
              );
            }
            if (
              process.env.FERRY_SMOKE_STATE_FILE &&
              process.env.FERRY_SMOKE_SEED_DATA !== 'true'
            ) {
              const saved = JSON.parse(await readFile(process.env.FERRY_SMOKE_STATE_FILE, 'utf8'));
              const restored = await page.evaluate(async (state) => {
                const client = window.ferryRpcClient;
                const profiles = await client.profiles.list();
                const keys = await client.gateway.listKeys();
                return {
                  theme: (await client.settings.get()).theme,
                  title: (await client.sessions.get(state.sessionId)).session.title,
                  profile: profiles.find((profile) => profile.id === state.profileId)
                    ?.routingObjective,
                  keyProfile: keys.find((key) => key.id === state.keyId)?.profile,
                  hasSecret: Boolean(await client.gateway.keySecret(state.keyId)),
                };
              }, saved);
              if (
                restored.theme !== saved.theme ||
                restored.title !== 'Installer persistence smoke' ||
                restored.profile !== 'latency' ||
                restored.keyProfile !== saved.profileId ||
                !restored.hasSecret
              )
                throw new Error(
                  'Upgrade did not restore settings/session/routing/key configuration',
                );
              console.log(
                'Packaged restart restores settings, custom routing and retrievable Gateway key',
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
            if (firstRunOnboardingVisible) {
              // This native-module smoke does not generate provider traffic. The packaged
              // golden path separately completes the real six-step Gateway onboarding.
              await page.evaluate(() =>
                window.ferryRpcClient.settings.update({ onboardingComplete: true }),
              );
              await page.reload();
            }
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

async function waitForCoreLog() {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const logNames = await readdir(join(userDataDirectory, 'engine', 'logs'));
      for (const name of logNames.filter((entry) => /^ferry(?:\.\d+)?\.log$/.test(entry))) {
        const log = await readFile(join(userDataDirectory, 'engine', 'logs', name), 'utf8');
        if (log.includes('Ferry core started')) return log;
      }
      lastError = new Error('Rotated Ferry log files are present but lack the startup record.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    'Packaged core log did not contain its startup record in ' +
      join(userDataDirectory, 'engine', 'logs') +
      ': ' +
      (lastError?.message ?? 'timeout'),
  );
}

void waitForRendererLoad()
  .then(waitForCoreLog)
  .then(() => {
    console.log('Packaged core log written');
    console.log('Packaged smoke passed');
    return finish();
  })
  .catch((error) => finish(error));
