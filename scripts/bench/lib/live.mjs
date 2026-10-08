import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { access, mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { root } from './options.mjs';
import { run, start, stop, waitFor } from './process.mjs';

const requireCli = createRequire(join(root, 'apps/cli/package.json'));
export const remove = (path) =>
  rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

export function environment(service) {
  // Never inherit test injection, cloud configuration, or provider secrets into agent tools.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('FERRY_')),
  );
  return { ...env, FERRY_KEYRING_SERVICE: service, FERRY_ENGINE: 'local' };
}

export function cliCommand(cli, args) {
  if (/\.[cm]?js$/i.test(cli)) return [process.execPath, [cli, ...args]];
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) {
    // Avoid shell interpolation of arbitrary prompts, quotes and apostrophes. Ferry's
    // standard cmd wrapper launches the adjacent ferry.js; use that entry directly.
    return [process.execPath, [join(resolve(cli, '..'), 'ferry.js'), ...args]];
  }
  return [cli, args];
}

async function storedReferences() {
  const { Entry } = requireCli('@napi-rs/keyring');
  const data =
    process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Ferry/engine')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library/Application Support/Ferry/engine')
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Ferry/engine');
  const references = [];
  let database;
  try {
    // better-sqlite3 throws a plain TypeError for a missing parent directory;
    // check existence first so legacy keyring-only installs still work.
    await access(join(data, 'db/ferry.sqlite'));
    const Database = requireCli('better-sqlite3');
    database = new Database(join(data, 'db/ferry.sqlite'), { readonly: true, fileMustExist: true });
    const hasEntries = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_key_entries'")
      .get();
    references.push(
      ...database
        .prepare(
          hasEntries
            ? 'SELECT provider_id AS provider, keyring_ref AS account FROM provider_key_entries WHERE enabled=1'
            : 'SELECT provider_id AS provider, keyring_ref AS account FROM provider_keys',
        )
        .all(),
    );
  } catch (error) {
    if (!['ENOENT', 'SQLITE_CANTOPEN'].includes(error.code)) throw error;
  } finally {
    database?.close();
  }
  const limits = join(root, 'packages/catalog/data/limits');
  for (const filename of await readdir(limits)) {
    if (!filename.endsWith('.yaml') || filename.startsWith('dead-')) continue;
    const provider = /^provider:\s*['"]?([\w-]+)/m.exec(
      await readFile(join(limits, filename), 'utf8'),
    )?.[1];
    if (!provider) continue;
    if (!references.some((item) => item.provider === provider))
      references.push({ provider, account: provider });
  }
  return { references, Entry };
}

export async function withLive(options, action) {
  await access(options.cli);
  const guard = await import(
    new URL('../../../apps/desktop/scripts/real-keyring-guard.mjs', import.meta.url)
  );
  const service = `Ferry-Bench-${process.pid}`;
  const secrets = [];
  let stored;
  if (options['use-stored-keys']) {
    console.warn(
      'WARNING: --use-stored-keys reads the real Ferry keyring; live provider requests consume its quotas. Keys are copied into an isolated bench service.',
    );
    stored = await storedReferences();
  } else {
    for (const [name, value] of Object.entries(process.env)) {
      const match = /^FERRY_LIVE_([A-Z0-9_]+)_KEY$/.exec(name);
      if (match && value?.trim())
        secrets.push({ provider: match[1].toLowerCase().replaceAll('_', '-'), value });
    }
  }
  const accounts = [
    ...new Set([
      ...guard.GUARDED_ACCOUNTS,
      ...(stored?.references.map((item) => item.account) ?? []),
      ...secrets.flatMap(({ provider }) => [provider, `${provider}:1`]),
    ]),
  ];
  const snapshot = guard.snapshotRealKeyring(accounts);
  const temporary = await mkdtemp(join(tmpdir(), 'ferry-bench-'));
  const dataDir = join(temporary, 'engine');
  const env = environment(service);
  const children = new Set();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    for (const child of children) void stop(child);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const invoke = async (args, settings = {}) => {
    if (interrupted) throw new Error('Run interrupted');
    const [command, argv] = cliCommand(options.cli, [
      ...args,
      '--engine',
      'local',
      '--data-dir',
      dataDir,
    ]);
    let child;
    try {
      return await run(command, argv, {
        env,
        timeoutMs: 120_000,
        ...settings,
        onStart: (started) => {
          child = started;
          children.add(child);
        },
      });
    } finally {
      children.delete(child);
    }
  };
  const benchAccounts = [];
  let coreChild;
  const attachedCore = async () => {
    if (coreChild) return coreChild;
    coreChild = start(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts/bench/lib/core-holder.mjs'), dataDir],
      { env, cwd: root, detached: process.platform !== 'win32' },
    );
    children.add(coreChild);
    await waitFor(async () => {
      if (coreChild.exitCode !== null) throw new Error('Attached core failed to start');
      try {
        const lock = JSON.parse(await readFile(join(dataDir, 'core.lock'), 'utf8'));
        await access(join(dataDir, 'core.endpoint.json'));
        return lock.pid === coreChild.pid;
      } catch {
        return false;
      }
    });
    return coreChild;
  };
  try {
    if (stored)
      for (const { provider, account } of stored.references) {
        let value;
        try {
          value = new stored.Entry('Ferry', account).getPassword();
        } catch {
          continue;
        }
        if (value) secrets.push({ provider, value });
      }
    if (!secrets.length)
      return await action({ skipped: 'skipped: no provider keys', temporary, dataDir });
    // Keep discovery alive between key addition and runs instead of disposing an
    // embedded core while its asynchronous keyChanged discovery is in progress.
    await attachedCore();
    const providers = [];
    const seeded = new Map();
    for (const { provider, value } of secrets) {
      // Register before the write, so failures after persistence still get cleaned.
      const index = (seeded.get(provider) ?? 0) + 1;
      seeded.set(provider, index);
      benchAccounts.push(`${provider}:${index}`, provider);
      const result = await invoke(
        ['providers', 'keys', provider, 'add', '--stdin', '--label', 'Bench', '--json'],
        { input: `${value}\n` },
      );
      if (result.code !== 0 || result.timedOut)
        throw new Error(`Failed to seed isolated key for ${provider} (exit ${result.code})`);
      providers.push(provider);
    }
    const scrub = (value) => {
      let text = value;
      for (const secret of secrets) {
        text = text.replaceAll(secret.value, '[REDACTED]');
        text = text.replaceAll(JSON.stringify(secret.value).slice(1, -1), '[REDACTED]');
      }
      return text;
    };
    const safeInvoke = async (...args) => {
      const result = await invoke(...args);
      return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
    };
    await action({
      temporary,
      dataDir,
      env,
      scrub,
      invoke: safeInvoke,
      providers: [...new Set(providers)],
      attachedCore,
    });
    if (interrupted) throw new Error('Run interrupted');
  } finally {
    try {
      try {
        for (const child of children) await stop(child);
      } finally {
        guard.cleanupTestKeyring(service, benchAccounts);
      }
    } finally {
      try {
        guard.assertRealKeyringUnchanged(snapshot);
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
        await remove(temporary);
      }
    }
  }
}
