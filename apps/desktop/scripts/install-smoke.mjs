import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

if (process.platform !== 'win32') throw new Error('The installer smoke requires Windows.');

const root = resolve(import.meta.dirname, '../../..');
const desktopRoot = resolve(import.meta.dirname, '..');
const outputDirectory = join(desktopRoot, 'release');
const args = process.argv.slice(2);
const installerArgument = args.indexOf('--installer');
if (installerArgument >= 0 && !args[installerArgument + 1])
  throw new Error('--installer requires a path.');
const requestedInstaller = installerArgument >= 0 ? resolve(args[installerArgument + 1]) : null;
const rows = [];
const require = createRequire(join(desktopRoot, 'package.json'));
const Database = require('better-sqlite3');
let tempRoot;
let originalUserPath;
let didSetUserPath = false;
let generatedUpgradeInstaller;
let generatedUpgradePortable;
let updateBrowser;
let updateApplication;
const isCi = process.env.GITHUB_ACTIONS === 'true';
const realRoamingDirectory = powershell("[Environment]::GetFolderPath('ApplicationData')");
const realFerryData = join(realRoamingDirectory, 'Ferry');
const realLegacyData = join(realRoamingDirectory, '@ferry', 'desktop');
const seededRealProfileFiles = [];
const createdRealProfileDirectories = [];

function record(label, status, detail = '') {
  rows.push({ label, status, detail });
  console.log(`${status.padEnd(4)} ${label}${detail ? ` — ${detail}` : ''}`);
}
function quoteCommandArgument(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
function run(command, commandArgs, options = {}) {
  const isCmdShim = command.toLowerCase().endsWith('.cmd');
  const commandLine = [command, ...commandArgs].map(quoteCommandArgument).join(' ');
  const result = spawnSync(
    isCmdShim ? 'cmd.exe' : command,
    isCmdShim ? ['/d', '/s', '/c', `"${commandLine}"`] : commandArgs,
    {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      encoding: 'utf8',
      timeout: options.timeout ?? 180_000,
      windowsHide: true,
      windowsVerbatimArguments: isCmdShim,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.status}`,
    );
  return result.stdout.trim();
}
function powershell(script) {
  // Read-only queries: unreadable registry subkeys set a failing status even with
  // -ErrorAction SilentlyContinue (seen on clean GitHub runners), so exit 0 explicitly.
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${script}; exit 0`], {
    timeout: 30_000,
  });
}
function safePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
async function newestInstaller() {
  const files = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^Ferry-Setup-.+\.exe$/i.test(entry.name))
    .map((entry) => join(outputDirectory, entry.name));
  const candidates = await Promise.all(
    files.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })),
  );
  candidates.sort((a, b) => b.modified - a.modified);
  const found = candidates[0]?.path;
  if (!found) throw new Error(`No built installer found in ${outputDirectory}`);
  return found;
}
function releaseVersion(installer) {
  return /Ferry-Setup-(.+)\.exe$/i.exec(installer)?.[1] ?? '0.0.0';
}
function greaterVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return '99.0.0';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
function registryInstallations() {
  const script = `$root='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.DisplayName -like 'Ferry*') { [PSCustomObject]@{ Key=$_.PSChildName; Location=$p.InstallLocation } } } | ConvertTo-Json -Compress`;
  const result = powershell(script);
  if (!result) return [];
  const parsed = JSON.parse(result);
  return Array.isArray(parsed) ? parsed : [parsed];
}
// The uninstall entry carries the version; electron-builder keeps InstallLocation under
// HKCU\Software\<app GUID> (its INSTALL_REGISTRY_KEY), keyed by the same GUID.
function ferryRegistryRows() {
  const script = `$root='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.DisplayName -like 'Ferry*') { $i=Get-ItemProperty ('HKCU:\\Software\\' + $_.PSChildName) -ErrorAction SilentlyContinue; [PSCustomObject]@{ Key=$_.PSChildName; Location=$i.InstallLocation; Version=$p.DisplayVersion } } } | ConvertTo-Json -Compress`;
  const result = powershell(script);
  if (!result) return [];
  const parsed = JSON.parse(result);
  return Array.isArray(parsed) ? parsed : [parsed];
}
// CI temp folders mix 8.3 short (RUNNER~1) and long spellings; compare canonical paths.
function registryRowsForLocation(location) {
  const wanted = canonicalPath(location);
  return ferryRegistryRows().filter(
    (row) => typeof row.Location === 'string' && canonicalPath(row.Location) === wanted,
  );
}
function hasRunningNsisUninstallerCopy() {
  const script =
    "$matches = @(Get-Process | Where-Object { $_.Path -like '*\\~nsu*' -and $_.ProcessName -match '^(Un_|Au_)' }); if ($matches.Count -gt 0) { 'running' } else { 'idle' }";
  return powershell(script) === 'running';
}
async function install(installer, directory, profile, addToPath = false, testOptions = false) {
  await access(installer);
  const env = {
    ...process.env,
    APPDATA: join(profile, 'Roaming'),
    LOCALAPPDATA: join(profile, 'Local'),
  };
  const installArgs = [
    '/S',
    ...(addToPath ? ['/ADD_TO_PATH'] : []),
    ...(testOptions ? ['/TEST_OPTIONS'] : []),
    `/D=${directory}`,
  ];
  run(installer, installArgs, { env, timeout: 240_000 });
  await access(join(directory, 'Ferry.exe'));
  await access(join(directory, 'Uninstall Ferry.exe'));
}
async function runInstalledSmoke(directory, profile, stateFile, seed) {
  const dataDirectory = join(profile, 'Roaming', 'Ferry');
  const cli = join(directory, 'resources', 'cli', 'ferry.cmd');
  const env = {
    ...process.env,
    APPDATA: join(profile, 'Roaming'),
    LOCALAPPDATA: join(profile, 'Local'),
    FERRY_SMOKE_EXECUTABLE: join(directory, 'Ferry.exe'),
    FERRY_SMOKE_CLI: cli,
    FERRY_SMOKE_DATA_DIR: dataDirectory,
    FERRY_SMOKE_PRESERVE_DATA: 'true',
    FERRY_SMOKE_SEED_DATA: seed ? 'true' : 'false',
    FERRY_SMOKE_STATE_FILE: stateFile,
  };
  run(process.execPath, [join(desktopRoot, 'scripts', 'smoke-packaged.mjs')], {
    env,
    timeout: 150_000,
  });
  const status = run(cli, ['status', '--json', '--data-dir', join(dataDirectory, 'engine')], {
    env,
    timeout: 30_000,
  });
  const parsed = JSON.parse(status);
  assert.equal(
    parsed.engine,
    'local',
    `Installed ferry.cmd status did not report local engine: ${status}`,
  );
  run(process.execPath, [join(desktopRoot, 'scripts', 'cli-interactive-smoke.mjs')], {
    env: {
      ...env,
      FERRY_E2E_PROVIDER_IDS: 'openrouter',
      FERRY_E2E_PROVIDER_KEY: 'fixture-key',
    },
    timeout: 120_000,
  });
}
function insertKeyReference(databasePath) {
  const db = new Database(databasePath);
  try {
    db.prepare(
      'INSERT OR REPLACE INTO provider_keys (id,provider_id,keyring_ref,created_at) VALUES (?,?,?,?)',
    ).run('install-smoke-key', 'openai', 'install-smoke-reference-only', new Date().toISOString());
  } finally {
    db.close();
  }
}
function verifyPersistedRecords(databasePath, state) {
  const db = new Database(databasePath, { readonly: true });
  try {
    const settings = db.prepare("SELECT value_json FROM settings_kv WHERE key='global'").get();
    assert.ok(settings, 'Global settings row was not persisted');
    const settingsValue = JSON.parse(settings.value_json);
    assert.equal(settingsValue.theme, state.theme, 'Theme setting did not survive upgrade');
    const session = db.prepare('SELECT data_json FROM sessions WHERE id=?').get(state.sessionId);
    assert.ok(session, 'Smoke session was not persisted');
    assert.equal(JSON.parse(session.data_json).title, 'Installer persistence smoke');
    const keyReference = db
      .prepare("SELECT keyring_ref FROM provider_keys WHERE id='install-smoke-key'")
      .get();
    assert.equal(keyReference?.keyring_ref, 'install-smoke-reference-only');
  } finally {
    db.close();
  }
}
function userPath() {
  return powershell("[Environment]::GetEnvironmentVariable('Path','User')");
}
async function seedRealProfileFile(directory, name) {
  if (!(await exists(directory))) {
    let ancestor = directory;
    const missingDirectories = [];
    while (ancestor !== realRoamingDirectory && !(await exists(ancestor))) {
      missingDirectories.unshift(ancestor);
      ancestor = dirname(ancestor);
    }
    await mkdir(directory, { recursive: true });
    createdRealProfileDirectories.push(...missingDirectories);
  }
  const file = join(directory, name);
  await writeFile(file, 'install smoke sentinel', 'utf8');
  seededRealProfileFiles.push(file);
  return file;
}
async function cleanRealProfileSentinels() {
  for (const file of seededRealProfileFiles) await rm(file, { force: true });
  for (const directory of [...createdRealProfileDirectories].reverse())
    await rmdir(directory).catch(() => undefined);
}
function expandEnvironmentVariables(value) {
  const environment = new Map(
    Object.entries(process.env).map(([name, variable]) => [name.toLowerCase(), variable]),
  );
  return value.replace(/%([^%]+)%/g, (match, name) => environment.get(name.toLowerCase()) ?? match);
}
function lexicalPath(value) {
  return resolve(expandEnvironmentVariables(value.replace(/^"|"$/g, ''))).toLowerCase();
}
function canonicalPath(value) {
  const expanded = expandEnvironmentVariables(value.replace(/^"|"$/g, ''));
  try {
    return realpathSync.native(expanded).toLowerCase();
  } catch {
    return resolve(expanded).toLowerCase();
  }
}
function userPathEntries(value = userPath()) {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
function matchingPathEntries(value, directory) {
  const canonicalDirectory = canonicalPath(directory);
  return userPathEntries(value).filter((entry) => canonicalPath(entry) === canonicalDirectory);
}
function setUserPath(value) {
  const literal = safePowerShellLiteral(value);
  powershell(`[Environment]::SetEnvironmentVariable('Path',${literal},'User')`);
}
async function uninstall(directory, profile, removeData = false) {
  const env = {
    ...process.env,
    APPDATA: join(profile, 'Roaming'),
    LOCALAPPDATA: join(profile, 'Local'),
  };
  run(join(directory, 'Uninstall Ferry.exe'), ['/S', ...(removeData ? ['/REMOVE_DATA'] : [])], {
    env,
    timeout: 180_000,
  });
  const uninstallExecutable = join(directory, 'Uninstall Ferry.exe');
  const ferryExecutable = join(directory, 'Ferry.exe');
  const deadline = Date.now() + 180_000;
  let state;
  do {
    state = {
      uninstallExecutableExists: await exists(uninstallExecutable),
      ferryExecutableExists: await exists(ferryExecutable),
      registryEntries: registryRowsForLocation(directory).length,
      runningNsisCopy: hasRunningNsisUninstallerCopy(),
    };
    if (
      !state.uninstallExecutableExists &&
      !state.ferryExecutableExists &&
      state.registryEntries === 0 &&
      !state.runningNsisCopy
    )
      return;
    if (Date.now() >= deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  } while (Date.now() < deadline);
  // Which processes still run from this folder (a Ferry hidden in the tray would lock files).
  const prefix = canonicalPath(directory);
  const holders = (() => {
    try {
      const raw = powershell(
        '@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { [PSCustomObject]@{ Id=$_.ProcessId; Name=$_.Name; Path=$_.ExecutablePath; Cmd=$_.CommandLine } }) | ConvertTo-Json -Compress',
      );
      const parsed = raw ? JSON.parse(raw) : [];
      return (Array.isArray(parsed) ? parsed : [parsed])
        .filter((item) => canonicalPath(item.Path).startsWith(prefix))
        .map((item) => `${String(item.Id)} ${item.Name} ${String(item.Cmd ?? '').slice(0, 160)}`);
    } catch (error) {
      return [
        `(process listing failed: ${error instanceof Error ? error.message : String(error)})`,
      ];
    }
  })();
  throw new Error(
    `Timed out after 180 seconds waiting for uninstall completion at ${directory} ` +
      `(Uninstall Ferry.exe: ${state?.uninstallExecutableExists ? 'present' : 'gone'}; ` +
      `Ferry.exe: ${state?.ferryExecutableExists ? 'present' : 'gone'}; ` +
      `registry entries: ${state?.registryEntries ?? 'unknown'}; ` +
      `NSIS temporary process: ${state?.runningNsisCopy ? 'running' : 'none'}; ` +
      `processes from this folder: ${holders.length ? holders.join(' | ') : 'none'}).`,
  );
}

try {
  const softwareKey = powershell(
    "if (Test-Path 'HKCU:\\Software\\Ferry') { 'present' } else { 'absent' }",
  );
  const installations = registryInstallations();
  const standardInstall = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ferry');
  if (softwareKey === 'present' || installations.length > 0 || (await exists(standardInstall)))
    throw new Error(
      'Refusing to run: an existing Ferry installation or HKCU Ferry settings key could be affected.',
    );

  // Long-form path: CI's TEMP is spelled with 8.3 names (RUNNER~1), but Windows reports running
  // processes by long path, and electron-builder's installer/uninstaller find a running Ferry with
  // Path.StartsWith($INSTDIR). A short $INSTDIR means they never stop it and its files stay locked.
  tempRoot = realpathSync.native(await mkdtemp(join(tmpdir(), 'ferry-install-upgrade-smoke-')));
  const baseInstaller = requestedInstaller ?? (await newestInstaller());
  await access(baseInstaller);
  const baseVersion = releaseVersion(baseInstaller);
  let upgrade = greaterVersion(baseVersion);
  while (
    (await exists(join(outputDirectory, `Ferry-Setup-${upgrade}.exe`))) ||
    (await exists(join(outputDirectory, `Ferry-${upgrade}-portable.exe`)))
  )
    upgrade = greaterVersion(upgrade);
  generatedUpgradeInstaller = join(outputDirectory, `Ferry-Setup-${upgrade}.exe`);
  generatedUpgradePortable = join(outputDirectory, `Ferry-${upgrade}-portable.exe`);
  const pnpm = join(root, 'tools', 'pnpm.cmd');
  run(pnpm, ['--filter', '@ferry/desktop', 'dist'], {
    env: { ...process.env, FERRY_RELEASE_VERSION: upgrade },
    timeout: 900_000,
  });
  await access(generatedUpgradeInstaller);
  const previousBlockmap = `${baseInstaller}.blockmap`;
  const updatedBlockmap = `${generatedUpgradeInstaller}.blockmap`;
  await access(previousBlockmap);
  await access(updatedBlockmap);
  record(
    'Previous and updated installer blockmaps are available',
    'PASS',
    `${(await stat(previousBlockmap)).size} + ${(await stat(updatedBlockmap)).size} bytes`,
  );
  record('Build higher-stamped upgrade installer', 'PASS', `${baseVersion} -> ${upgrade}`);

  const installDirectory = join(tempRoot, 'default-install');
  const profile = join(tempRoot, 'default-profile');
  const stateFile = join(tempRoot, 'persistence.json');
  await install(baseInstaller, installDirectory, profile);
  record('Silent per-user clean install in isolated directories', 'PASS');
  await runInstalledSmoke(installDirectory, profile, stateFile, true);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.theme, 'light');
  const dataDirectory = join(profile, 'Roaming', 'Ferry');
  const databasePath = join(dataDirectory, 'engine', 'db', 'ferry.sqlite');
  insertKeyReference(databasePath);
  verifyPersistedRecords(databasePath, state);
  record('Installed app hello reports all real domains', 'PASS');
  record('Installed ferry.cmd status reports local engine', 'PASS');

  const beforePath = userPath();
  const fullInstallerBytes = (await stat(generatedUpgradeInstaller)).size;
  const upgradeEnv = {
    ...process.env,
    APPDATA: join(profile, 'Roaming'),
    LOCALAPPDATA: join(profile, 'Local'),
    FERRY_INSTALL_SMOKE: 'true',
    FERRY_E2E_USER_DATA_DIR: dataDirectory,
  };
  // electron-updater closes the running N-1 app before spawning the silent updated installer.
  updateApplication = spawn(join(installDirectory, 'Ferry.exe'), ['--remote-debugging-port=0'], {
    env: upgradeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('Previous app did not expose DevTools')),
      30_000,
    );
    const onData = (chunk) => {
      output += chunk.toString();
      const found = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)?.[1];
      if (found) {
        clearTimeout(timer);
        resolveEndpoint(found);
      }
    };
    updateApplication.stderr.on('data', onData);
    updateApplication.stdout.on('data', onData);
    updateApplication.once('error', reject);
  });
  updateBrowser = await chromium.connectOverCDP(endpoint);
  const oldPage = updateBrowser.contexts()[0].pages()[0];
  await oldPage.waitForFunction(() => Boolean(window.ferryHost));
  assert.equal((await oldPage.evaluate(() => window.ferryHost.getAppInfo())).version, baseVersion);
  const oldExit = new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('Previous app did not shut down')), 15_000);
    updateApplication.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  const session = await updateBrowser.newBrowserCDPSession();
  // The app exits before CDP can answer, so this promise may never settle: don't await it, or
  // Node runs out of work and quits mid-script. The process exit is the signal we wait for.
  void session.send('Browser.close').catch(() => undefined);
  await oldExit;
  updateApplication = undefined;
  updateBrowser = undefined;
  const upgradeStartedAt = Date.now();
  run(generatedUpgradeInstaller, ['--updated', '/S', '--force-run', `/D=${installDirectory}`], {
    env: upgradeEnv,
    timeout: 60_000,
  });
  const upgradeWallTimeMs = Date.now() - upgradeStartedAt;
  assert.ok(upgradeWallTimeMs < 60_000, 'Updated installer exceeded 60 seconds');
  assert.equal(
    registryRowsForLocation(installDirectory)[0]?.Version,
    upgrade,
    `Registry after update: ${JSON.stringify(ferryRegistryRows())}; install dir ${installDirectory}`,
  );
  // Processes report long paths; the CI install dir is spelled with 8.3 short names (RUNNER~1),
  // so match by canonical path instead of comparing strings in PowerShell.
  const installedExecutable = canonicalPath(join(installDirectory, 'Ferry.exe'));
  const ferryProcesses = () => {
    const raw = powershell(
      '@(Get-CimInstance Win32_Process -Filter "Name=\'Ferry.exe\'" | ForEach-Object { [PSCustomObject]@{ Id=$_.ProcessId; Path=$_.ExecutablePath } }) | ConvertTo-Json -Compress',
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (item) => typeof item.Path === 'string' && canonicalPath(item.Path) === installedExecutable,
    );
  };
  const running = () => ferryProcesses().length;
  const relaunchDeadline = Date.now() + 30_000;
  while (running() === 0 && Date.now() < relaunchDeadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  assert.ok(running() > 0, 'Updated installer did not relaunch Ferry.exe');
  record(
    'Real --updated /S --force-run changes version and relaunches Ferry in under 60 s',
    'PASS',
    `${upgradeWallTimeMs} ms; ${baseVersion} -> ${upgrade}`,
  );
  // Close the relaunched GUI before the persistence smoke creates its own isolated app process.
  const processIds = () => ferryProcesses().map((item) => Number(item.Id));
  const ids = processIds();
  if (ids.length)
    powershell(
      `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`,
    );
  const closeDeadline = Date.now() + 10_000;
  while (running() > 0 && Date.now() < closeDeadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  // The installer relaunches Ferry through the shell (no smoke environment), so closing the
  // window can hide it to the tray as designed; end it like Quit from the tray would.
  const remaining = processIds();
  if (remaining.length)
    powershell(`Stop-Process -Id ${remaining.join(',')} -Force -ErrorAction SilentlyContinue`);
  const killDeadline = Date.now() + 10_000;
  while (running() > 0 && Date.now() < killDeadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  assert.equal(running(), 0, 'Relaunched app did not close');
  verifyPersistedRecords(databasePath, state);
  const installedFileCount = await countFiles(installDirectory);
  record(
    'Silent full-installer control measurement',
    'INFO',
    `${fullInstallerBytes} bytes; ${upgradeWallTimeMs} ms; ${installedFileCount} installed files`,
  );
  record('Higher-version install preserves settings, session, and key reference', 'PASS');
  await runInstalledSmoke(installDirectory, profile, stateFile, false);
  const relaunchedState = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(relaunchedState.theme, state.theme);
  record('Updated app relaunches with persisted profile data', 'PASS');
  let defaultDataStatus = 'SKIP';
  let defaultDataDetail = isCi
    ? 'real roaming data path is unavailable for sentinel verification'
    : 'only runs on CI to avoid touching a real user profile';
  let defaultSentinel;
  if (isCi) {
    defaultSentinel = await seedRealProfileFile(realFerryData, 'default-uninstall-smoke.txt');
  }
  await uninstall(installDirectory, profile);
  await access(databasePath);
  assert.deepEqual(registryRowsForLocation(installDirectory), []);
  assert.equal(userPath(), beforePath, 'Default uninstall unexpectedly changed user PATH');
  if (defaultSentinel) {
    assert.equal(
      await exists(defaultSentinel),
      true,
      'Default uninstall removed the current user data sentinel',
    );
    defaultDataStatus = 'PASS';
    defaultDataDetail = '';
    await cleanRealProfileSentinels();
  }
  record('Default uninstall keeps Ferry data', defaultDataStatus, defaultDataDetail);
  record('Default uninstall removes its registry key and preserves PATH', 'PASS');

  const pathInstall = join(tempRoot, 'path-install');
  const pathProfile = join(tempRoot, 'path-profile');
  originalUserPath = userPath();
  didSetUserPath = true;
  await install(generatedUpgradeInstaller, pathInstall, pathProfile, false, true);
  const addedPath = userPath();
  const cliPath = join(pathInstall, 'resources', 'cli');
  const addedEntries = matchingPathEntries(addedPath, cliPath);
  assert.equal(
    addedEntries.length,
    1,
    'Installer did not add exactly one CLI directory to user PATH',
  );
  const optionsState = powershell(
    "if ((Get-ItemProperty 'HKCU:\\Software\\Ferry' -ErrorAction SilentlyContinue).ExplorerMenu -eq 1 -and (Test-Path 'HKCU:\\Software\\Classes\\Directory\\shell\\Ferry\\command')) { 'enabled' } else { 'disabled' }",
  );
  assert.equal(optionsState, 'enabled', 'Interactive Open in Ferry option was not applied');
  record('Stored interactive options apply PATH and Open in Ferry', 'PASS');
  run(generatedUpgradeInstaller, ['/S', '/TEST_UPDATED', `/D=${pathInstall}`], {
    env: {
      ...process.env,
      APPDATA: join(pathProfile, 'Roaming'),
      LOCALAPPDATA: join(pathProfile, 'Local'),
    },
    timeout: 240_000,
  });
  assert.equal(
    matchingPathEntries(userPath(), cliPath).length,
    1,
    'Upgrade did not preserve the selected PATH option exactly once',
  );
  record('Updated-mode test switch preserves PATH and avoids a duplicate entry', 'PASS');
  const cliPathAliases = new Set([lexicalPath(cliPath), ...addedEntries.map(lexicalPath)]);
  const canVerifyRemoveData =
    isCi && !(await exists(realFerryData)) && !(await exists(realLegacyData));
  if (canVerifyRemoveData) {
    await seedRealProfileFile(realFerryData, 'remove-data-smoke.txt');
    await seedRealProfileFile(realLegacyData, 'remove-data-smoke.txt');
  }
  await uninstall(pathInstall, pathProfile, canVerifyRemoveData);
  if (canVerifyRemoveData) {
    assert.equal(
      await exists(realFerryData),
      false,
      'Selected remove-data uninstall retained current user data',
    );
    assert.equal(
      await exists(realLegacyData),
      false,
      'Selected remove-data uninstall retained legacy user data',
    );
    record('Opt-in uninstall removes current and legacy user data', 'PASS');
  } else {
    record(
      'Opt-in uninstall removes current and legacy user data',
      'SKIP',
      isCi
        ? 'real roaming Ferry or legacy data already exists; refusing to risk deleting user data'
        : 'only runs on CI to avoid touching a real user profile',
    );
  }
  const remainingPathEntries = userPathEntries();
  assert.ok(
    !remainingPathEntries.some(
      (entry) =>
        canonicalPath(entry) === canonicalPath(cliPath) || cliPathAliases.has(lexicalPath(entry)),
    ),
    'Uninstall left the selected Ferry CLI PATH entry behind',
  );
  assert.deepEqual(registryRowsForLocation(pathInstall), []);
  const explorerMenuAfterUninstall = powershell(
    "if (Test-Path 'HKCU:\\Software\\Classes\\Directory\\shell\\Ferry') { 'present' } else { 'absent' }",
  );
  assert.equal(
    explorerMenuAfterUninstall,
    'absent',
    'Uninstall left the Open in Ferry menu behind',
  );
  record('Opt-in uninstall removes PATH entry and both integration registry keys', 'PASS');
} catch (error) {
  record(
    'Install/upgrade/uninstall smoke',
    'FAIL',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await updateBrowser?.close().catch(() => undefined);
  updateApplication?.kill();
  if (didSetUserPath && originalUserPath !== undefined) {
    try {
      setUserPath(originalUserPath);
      record('Restore original user PATH after option verification', 'PASS');
    } catch (error) {
      record(
        'Restore original user PATH after option verification',
        'FAIL',
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    }
  }
  if (seededRealProfileFiles.length > 0) {
    try {
      await cleanRealProfileSentinels();
    } catch (error) {
      record(
        'Clean real profile smoke sentinels',
        'FAIL',
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    }
  }
  if (tempRoot) {
    const resolvedTemp = resolve(tempRoot);
    const resolvedSystemTemp = resolve(tmpdir());
    if (!resolvedTemp.toLowerCase().startsWith(`${resolvedSystemTemp.toLowerCase()}\\`)) {
      record(
        'Remove temporary install profiles',
        'FAIL',
        `Refusing cleanup outside temp root: ${resolvedTemp}`,
      );
      process.exitCode = 1;
    } else {
      try {
        await rm(resolvedTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error) {
        record(
          'Remove temporary install profiles',
          'FAIL',
          error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
      }
    }
  }
  if (generatedUpgradeInstaller)
    await rm(generatedUpgradeInstaller, { force: true, maxRetries: 8, retryDelay: 100 }).catch(
      () => undefined,
    );
  if (generatedUpgradeInstaller)
    await rm(`${generatedUpgradeInstaller}.blockmap`, {
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    }).catch(() => undefined);
  if (generatedUpgradePortable)
    await rm(generatedUpgradePortable, { force: true, maxRetries: 8, retryDelay: 100 }).catch(
      () => undefined,
    );
}

console.log('\nInstall smoke results');
console.table(rows);
if (rows.some(({ status }) => status === 'FAIL')) process.exitCode = 1;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    count += entry.isDirectory() ? await countFiles(path) : 1;
  }
  return count;
}
