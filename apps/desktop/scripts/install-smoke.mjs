import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve, relative } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanupTestKeyring } from './real-keyring-guard.mjs';

if (process.platform !== 'win32') throw new Error('The installer smoke requires Windows.');
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--resume'))
  throw new Error('Smoke builds isolated installers; production --installer input is unsafe.');
const root = resolve(import.meta.dirname, '../../..');
const desktop = resolve(import.meta.dirname, '..');
const temporary = realpathSync.native(
  args[1] ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'ferry-install-smoke-')),
);
const suffix = relative(realpathSync.native(tmpdir()), temporary);
if (!suffix || suffix.startsWith('..') || !suffix.startsWith('ferry-install-smoke-'))
  throw new Error('Smoke profile must be an owned directory under the system temporary directory');
const markerPath = join(temporary, 'smoke-profile.json');
const previous = args[1] ? JSON.parse(await readFile(markerPath, 'utf8')) : null;
if (
  previous &&
  (previous.root !== temporary ||
    previous.kind !== 'ferry-isolated-install-smoke' ||
    !/^ferry-smoke-\d+-\d+$/.test(previous.namespace))
)
  throw new Error('Refusing an unrecognized smoke profile');
const namespace = previous?.namespace ?? `ferry-smoke-${process.pid}-${Date.now()}`;
// Script-only fixes may reuse owned artifacts; changed compiled inputs force rebuilding.
const inputs = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/)
  .filter(
    (file) =>
      /^(?:apps|packages)\/.*\/src\//.test(file) ||
      /^packages\/catalog\/data\//.test(file) ||
      /(?:package\.json|electron-builder\.yml|installer\.nsh|pnpm-lock\.yaml|(?:electron\.vite|vite\.web|tsup)\.config\.ts)$/.test(
        file,
      ) ||
      /\/scripts\/(?:dist|after-pack|release-config|smoke-config|stage-runtime)\.mjs$/.test(file),
  )
  .sort();
const fingerprint = createHash('sha256');
for (const file of inputs) fingerprint.update(file).update(await readFile(join(root, file)));
const sourceHash = fingerprint.digest('hex');
const reuseBuilds = previous?.sourceHash === sourceHash;
await writeFile(
  markerPath,
  JSON.stringify({ kind: 'ferry-isolated-install-smoke', root: temporary, namespace, sourceHash }),
  'utf8',
);
const registry = `Software\\${namespace}`;
const profile = join(temporary, 'profile');
const roaming = join(profile, 'Roaming');
const data = join(roaming, 'Ferry');
const installation = join(temporary, "Ferry user's 日本語 install");
const rows = [];
let application;
let browser;
const env = {
  ...process.env,
  APPDATA: roaming,
  LOCALAPPDATA: join(profile, 'Local'),
  FERRY_INSTALL_SMOKE_ROOT: temporary,
  FERRY_INSTALL_SMOKE_NAMESPACE: namespace,
  FERRY_INSTALL_SMOKE: 'true',
  FERRY_KEYRING_SERVICE: `Ferry-Install-Smoke-${namespace}`,
  FERRY_E2E_USER_DATA_DIR: data,
  FERRY_DATA_DIR: join(data, 'engine'),
  FERRY_SKIP_SMOKE: '1',
};
function record(label) {
  rows.push({ label, status: 'PASS' });
  console.log(`PASS ${label}`);
}
async function run(command, args, overrides = {}) {
  return new Promise((resolveRun, reject) => {
    const shim = command.endsWith('.cmd');
    const line = [command, ...args].map((arg) => `"${arg.replaceAll('"', '""')}"`).join(' ');
    const child = spawn(shim ? 'cmd.exe' : command, shim ? ['/d', '/s', '/c', `"${line}"`] : args, {
      cwd: root,
      env: { ...env, ...overrides },
      windowsHide: true,
      windowsVerbatimArguments: shim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Smoke command exceeded 15 minutes'));
    }, 900_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolveRun(output) : reject(new Error(`Smoke command failed (${code})`));
    });
  });
}
function query(script) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env, timeout: 30_000 },
  );
  if (result.error || result.status !== 0) throw new Error('Isolated registry query failed');
  return result.stdout.trim();
}
function registryValue(key, name) {
  assert.ok(key.startsWith(registry + '\\'));
  return query(
    `(Get-ItemProperty -LiteralPath 'HKCU:\\${key}' -ErrorAction SilentlyContinue).${name}; exit 0`,
  );
}
async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function packaged(seed) {
  await run(process.execPath, [join(desktop, 'scripts/smoke-packaged.mjs')], {
    FERRY_SMOKE_EXECUTABLE: join(installation, 'Ferry.exe'),
    FERRY_SMOKE_CLI: join(installation, 'resources/cli/ferry.cmd'),
    FERRY_SMOKE_DATA_DIR: data,
    FERRY_SMOKE_PRESERVE_DATA: 'true',
    FERRY_SMOKE_SEED_DATA: String(seed),
    FERRY_SMOKE_STATE_FILE: join(temporary, 'state.json'),
  });
}
try {
  if (previous) await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  await mkdir(roaming, { recursive: true });
  // OS shell folders ignore APPDATA. Smoke builds disable shortcuts and isolate integrations.
  for (const version of ['1.0.0', '1.0.1']) {
    if (!reuseBuilds || !(await exists(join(temporary, 'release', `Ferry-Setup-${version}.exe`))))
      await run(join(root, 'tools/pnpm.cmd'), ['--filter', '@ferry/desktop', 'dist'], {
        FERRY_RELEASE_VERSION: version,
      });
    record(`Built isolated installer and portable ${version}`);
    const installer = join(temporary, 'release', `Ferry-Setup-${version}.exe`);
    await access(installer);
    await access(`${installer}.blockmap`);
    await access(join(temporary, 'release', `Ferry-${version}-portable.exe`));
    await run(installer, [
      '/S',
      ...(version === '1.0.1' ? ['--updated'] : ['/TEST_OPTIONS']),
      `/D=${installation}`,
    ]);
    await access(join(installation, 'Ferry.exe'));
    assert.equal(registryValue(`${registry}\\Preferences`, 'ExplorerMenu'), '1');
    assert.equal(
      registryValue(`${registry}\\Environment`, 'Path')
        .split(';')
        .filter((entry) => entry === join(installation, 'resources/cli')).length,
      1,
    );
    await packaged(version === '1.0.0');
    record(
      `${version} normal-user install/native modules/shared Core at space/apostrophe/Unicode paths`,
    );
  }
  const state = JSON.parse(await readFile(join(temporary, 'state.json'), 'utf8'));
  assert.equal(state.theme, 'light');
  assert.ok(state.keyId && state.profileId, 'Routing/key persistence was not verified');
  record('Upgrade restores settings, session, custom routing profile and retrievable Gateway key');
  await run(process.execPath, [join(desktop, 'scripts/e2e-real-domains.mjs')], {
    FERRY_E2E_EXECUTABLE: join(installation, 'Ferry.exe'),
    FERRY_E2E_ONLY: 'golden-path',
  });
  record('Installed packaged golden path and real fixture onboarding');
  await run(process.execPath, [join(desktop, 'scripts/cli-interactive-smoke.mjs')], {
    FERRY_SMOKE_EXECUTABLE: join(installation, 'Ferry.exe'),
    FERRY_SMOKE_CLI: join(installation, 'resources/cli/ferry.cmd'),
    FERRY_SMOKE_DATA_DIR: data,
  });
  record('Installed CLI Ctrl+C exit in cmd and PowerShell');
  await run(join(installation, 'Uninstall Ferry.exe'), ['/S']);
  await waitFor(
    async () => !(await exists(join(installation, 'Ferry.exe'))),
    'default uninstall',
    180_000,
  );
  await access(join(data, 'engine/db/ferry.sqlite'));
  record('Default uninstall preserves isolated data');
  await run(join(temporary, 'release/Ferry-Setup-1.0.1.exe'), [
    '/S',
    '/TEST_OPTIONS',
    `/D=${installation}`,
  ]);
  const legacy = join(roaming, '@ferry/desktop');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'sentinel'), 'isolated', 'utf8');
  await run(join(installation, 'Uninstall Ferry.exe'), ['/S', '/REMOVE_DATA']);
  await waitFor(
    async () =>
      !(await exists(data)) &&
      !(await exists(legacy)) &&
      !(await exists(join(installation, 'Ferry.exe'))),
    'opt-in uninstall',
    180_000,
  );
  assert.equal(registryValue(`${registry}\\Environment`, 'Path'), '');
  assert.equal(registryValue(`${registry}\\Preferences`, 'ExplorerMenu'), '');
  record('Opt-in uninstall removes only isolated data and integrations');
  const portableData = join(temporary, "portable user's 日本語 data");
  await mkdir(portableData, { recursive: true });
  const debuggingServer = createServer();
  await new Promise((resolveListen, reject) => {
    debuggingServer.once('error', reject);
    debuggingServer.listen(0, '127.0.0.1', resolveListen);
  });
  const debuggingPort = debuggingServer.address().port;
  await new Promise((resolveClose, reject) =>
    debuggingServer.close((error) => (error ? reject(error) : resolveClose())),
  );
  application = spawn(
    join(temporary, 'release/Ferry-1.0.1-portable.exe'),
    [
      `--remote-debugging-port=${debuggingPort}`,
      '--no-sandbox',
      '--disable-gpu',
      '--in-process-gpu',
      '--use-gl=swiftshader',
    ],
    {
      env: {
        ...env,
        FERRY_E2E_USER_DATA_DIR: portableData,
        FERRY_DATA_DIR: join(portableData, 'engine'),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let endpoint;
  let launchError;
  application.once('error', (error) => {
    launchError = error;
  });
  // The NSIS portable launcher does not forward its child's stderr. Probe its known
  // loopback debugging port instead of depending on a printed DevTools endpoint.
  await waitFor(
    async () => {
      if (launchError) throw launchError;
      if (application.exitCode !== null && application.exitCode !== 0)
        throw new Error(`Portable exited ${application.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) return false;
        endpoint = (await response.json()).webSocketDebuggerUrl;
        return typeof endpoint === 'string';
      } catch {
        return false;
      }
    },
    'portable DevTools readiness',
    60_000,
  );
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => Boolean(window.ferryRpcClient), undefined, { timeout: 30_000 });
  assert.ok(await page.evaluate(async () => (await window.ferryRpcClient.settings.get()).theme));
  record('Self-extracting portable loads renderer and native Core in isolated Unicode profile');
  const session = await browser.newBrowserCDPSession();
  void session.send('Browser.close').catch(() => undefined);
  await waitFor(() => application.exitCode !== null, 'portable graceful quit');
} catch (error) {
  rows.push({ label: error.message, status: 'FAIL' });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (application?.pid && application.exitCode === null)
    spawnSync('taskkill', ['/pid', String(application.pid), '/t', '/f'], { windowsHide: true });
  if (await exists(join(installation, 'Uninstall Ferry.exe'))) {
    await run(join(installation, 'Uninstall Ferry.exe'), ['/S']);
    await waitFor(
      async () => !(await exists(join(installation, 'Ferry.exe'))),
      'failed-smoke uninstall',
      180_000,
    );
  }
  if (await exists(join(temporary, 'state.json'))) {
    const state = JSON.parse(await readFile(join(temporary, 'state.json'), 'utf8'));
    cleanupTestKeyring(env.FERRY_KEYRING_SERVICE, state.keyId ? [`gateway:${state.keyId}`] : []);
  }
  query(
    `Remove-Item -LiteralPath 'HKCU:\\${registry}' -Recurse -Force -ErrorAction SilentlyContinue; exit 0`,
  );
  if (process.exitCode)
    console.error(
      `Isolated artifacts retained for diagnosis. Retry with --resume "${temporary}" (compiled input changes rebuild them).`,
    );
  else await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
console.table(rows);
