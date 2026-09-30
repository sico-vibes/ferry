import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
function registryRowsForLocation(location) {
  const literal = safePowerShellLiteral(location);
  const script = `$root='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.DisplayName -like 'Ferry*' -and $p.InstallLocation -eq ${literal}) { [PSCustomObject]@{ Key=$_.PSChildName; Location=$p.InstallLocation } } } | ConvertTo-Json -Compress`;
  const result = powershell(script);
  if (!result) return [];
  const parsed = JSON.parse(result);
  return Array.isArray(parsed) ? parsed : [parsed];
}
async function install(installer, directory, profile, addToPath = false) {
  await access(installer);
  const env = {
    ...process.env,
    APPDATA: join(profile, 'Roaming'),
    LOCALAPPDATA: join(profile, 'Local'),
  };
  const installArgs = ['/S', ...(addToPath ? ['/ADD_TO_PATH'] : []), `/D=${directory}`];
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

  tempRoot = await mkdtemp(join(tmpdir(), 'ferry-install-upgrade-smoke-'));
  const baseInstaller = requestedInstaller ?? (await newestInstaller());
  await access(baseInstaller);
  const baseVersion = releaseVersion(baseInstaller);
  let upgrade = greaterVersion(baseVersion);
  while (await exists(join(outputDirectory, `Ferry-Setup-${upgrade}.exe`)))
    upgrade = greaterVersion(upgrade);
  generatedUpgradeInstaller = join(outputDirectory, `Ferry-Setup-${upgrade}.exe`);
  const pnpm = join(root, 'tools', 'pnpm.cmd');
  run(pnpm, ['--filter', '@ferry/desktop', 'dist'], {
    env: { ...process.env, FERRY_RELEASE_VERSION: upgrade },
    timeout: 900_000,
  });
  await access(generatedUpgradeInstaller);
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
  const upgradeEnv = {
    ...process.env,
    APPDATA: join(profile, 'Roaming'),
    LOCALAPPDATA: join(profile, 'Local'),
  };
  run(generatedUpgradeInstaller, ['/S', `/D=${installDirectory}`], {
    env: upgradeEnv,
    timeout: 240_000,
  });
  verifyPersistedRecords(databasePath, state);
  record('Higher-version install preserves settings, session, and key reference', 'PASS');
  await uninstall(installDirectory, profile);
  await access(databasePath);
  assert.deepEqual(registryRowsForLocation(installDirectory), []);
  assert.equal(userPath(), beforePath, 'Default uninstall unexpectedly changed user PATH');
  record('Default uninstall keeps Ferry data and removes its registry key', 'PASS');

  const pathInstall = join(tempRoot, 'path-install');
  const pathProfile = join(tempRoot, 'path-profile');
  originalUserPath = userPath();
  didSetUserPath = true;
  await install(generatedUpgradeInstaller, pathInstall, pathProfile, true);
  const addedPath = userPath();
  const cliPath = join(pathInstall, 'resources', 'cli');
  assert.ok(
    addedPath.toLowerCase().includes(cliPath.toLowerCase()),
    'Installer did not add its CLI directory to user PATH',
  );
  const pathData = join(pathProfile, 'Roaming', 'Ferry');
  const legacyData = join(pathProfile, 'Roaming', '@ferry', 'desktop');
  await mkdir(pathData, { recursive: true });
  await mkdir(legacyData, { recursive: true });
  const sentinel = join(pathData, 'remove-data-smoke.txt');
  await (await import('node:fs/promises')).writeFile(sentinel, 'remove me', 'utf8');
  await uninstall(pathInstall, pathProfile, true);
  assert.equal(
    await exists(pathData),
    false,
    'Selected remove-data uninstall retained current user data',
  );
  assert.equal(
    await exists(legacyData),
    false,
    'Selected remove-data uninstall retained legacy user data',
  );
  assert.ok(
    !userPath().toLowerCase().includes(cliPath.toLowerCase()),
    'Uninstall left the selected Ferry CLI PATH entry behind',
  );
  assert.deepEqual(registryRowsForLocation(pathInstall), []);
  record('Opt-in uninstall removes Ferry data, PATH entry, and registry key', 'PASS');
} catch (error) {
  record(
    'Install/upgrade/uninstall smoke',
    'FAIL',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
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
  if (tempRoot) {
    const resolvedTemp = resolve(tempRoot);
    const resolvedSystemTemp = resolve(tmpdir());
    if (!resolvedTemp.toLowerCase().startsWith(`${resolvedSystemTemp.toLowerCase()}\\`))
      throw new Error(`Refusing cleanup outside temp root: ${resolvedTemp}`);
    await rm(resolvedTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  if (generatedUpgradeInstaller)
    await rm(generatedUpgradeInstaller, { force: true, maxRetries: 8, retryDelay: 100 }).catch(
      () => undefined,
    );
}

console.log('\nInstall smoke results');
console.table(rows);
if (rows.some(({ status }) => status !== 'PASS')) process.exitCode = 1;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
