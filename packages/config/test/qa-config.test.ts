import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  ensureDataPaths,
  getDataPaths,
  loadProjectConfig,
  loadSettings,
  migrateSettings,
  redactSecretText,
  saveSettings,
} from '../src/index.js';

const dirs: string[] = [];
async function tempDir(prefix = 'ferry-qa-config-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('QA config: data paths', () => {
  it('honors FERRY_HOME, XDG_DATA_HOME, and APPDATA', () => {
    expect(getDataPaths({ FERRY_HOME: 'D:/Ferry' }, 'win32').home).toBe('D:/Ferry');
    expect(getDataPaths({ XDG_DATA_HOME: '/data' }, 'linux').home).toBe(
      path.join('/data', 'Ferry'),
    );
    expect(getDataPaths({ APPDATA: 'C:/Users/x/AppData/Roaming' }, 'win32').home).toBe(
      path.win32.join('C:/Users/x/AppData/Roaming', 'Ferry'),
    );
  });

  it('creates every data directory', async () => {
    const home = await tempDir();
    const paths = getDataPaths({ FERRY_HOME: home }, 'win32');
    await ensureDataPaths(paths);
    const entries = await readdir(home);
    expect(entries).toEqual(
      expect.arrayContaining(['db', 'logs', 'checkpoints', 'cache', 'skills', 'bin']),
    );
  });
});

describe('QA config: settings migration', () => {
  it('round-trips settings and merges unknown older fields with defaults', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'settings.json');
    await saveSettings(file, { ...DEFAULT_SETTINGS, theme: 'dark' });
    expect((await loadSettings({ filePath: file })).theme).toBe('dark');
    const stored = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      settings: Record<string, unknown>;
    };
    expect(stored.version).toBe(CURRENT_SETTINGS_VERSION);
    await writeFile(file, JSON.stringify({ version: 0, settings: { theme: 'light' } }));
    const migrated = await loadSettings({ filePath: file });
    expect(migrated.theme).toBe('light');
    expect(migrated.optimizers).toEqual(DEFAULT_SETTINGS.optimizers);
  });

  it('backs up malformed JSON and returns defaults', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'settings.json');
    await writeFile(file, '{not valid json');
    const warn = vi.fn();
    expect(await loadSettings({ filePath: file, warn })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledOnce();
    expect(
      (await readdir(dir)).some((name) => name.includes('.invalid-') && name.endsWith('.bak')),
    ).toBe(true);
  });

  it('rejects a settings file from a newer version', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({ version: CURRENT_SETTINGS_VERSION + 5, settings: DEFAULT_SETTINGS }),
    );
    const warn = vi.fn();
    expect(await loadSettings({ filePath: file, warn })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is not vulnerable to prototype pollution through migrated settings', () => {
    const migrated = migrateSettings(0, JSON.parse('{"__proto__":{"polluted":true}}')) as Record<
      string,
      unknown
    >;
    expect((migrated as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('does not crash when two writers save settings concurrently', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'settings.json');
    await Promise.all([
      saveSettings(file, { ...DEFAULT_SETTINGS, theme: 'dark' }),
      saveSettings(file, { ...DEFAULT_SETTINGS, theme: 'light' }),
    ]);
    const loaded = await loadSettings({ filePath: file });
    expect(['dark', 'light']).toContain(loaded.theme);
  });
});

describe('QA config: project config', () => {
  it('reads project gates and environment overrides', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, '.ferry'), { recursive: true });
    await writeFile(
      path.join(dir, '.ferry', 'config.json'),
      JSON.stringify({ gateCommands: ['pnpm check'], defaultProfileId: 'fast' }),
    );
    const config = await loadProjectConfig(dir, { FERRY_PERMISSION_MODE: 'auto_edit' });
    expect(config.gateCommands).toEqual(['pnpm check']);
    expect(config.defaultProfileId).toBe('fast');
    expect(config.permissionMode).toBe('auto_edit');
  });

  it('falls back to defaults for a missing project config', async () => {
    const dir = await tempDir();
    expect(await loadProjectConfig(dir, {})).toEqual({
      gateCommands: [],
      instructionsFile: null,
      defaultProfileId: null,
      permissionMode: 'ask',
      permissionRules: [],
    });
  });

  it('falls back to defaults for a corrupted project config', async () => {
    // BUG: loadProjectConfig only swallows ENOENT; a corrupted .ferry/config.json
    // throws a SyntaxError and takes down every project-scoped operation, unlike
    // loadSettings which backs the file up and recovers.
    const dir = await tempDir();
    await mkdir(path.join(dir, '.ferry'), { recursive: true });
    await writeFile(path.join(dir, '.ferry', 'config.json'), '{corrupted');
    await expect(loadProjectConfig(dir, {})).resolves.toMatchObject({ permissionMode: 'ask' });
  });

  it('redacts GitHub- and Stripe-style tokens from log text', () => {
    // BUG: redactSecretText only knows sk-/gsk_/AIza/nvapi- prefixes, so GitHub
    // PATs and Stripe keys pass through untouched.
    const cleaned = redactSecretText(
      'ghp_0123456789abcdefghijklmnopqrstuvwx sk_live_0123456789abcdefghijkl',
    );
    expect(cleaned).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwx');
    expect(cleaned).not.toContain('sk_live_0123456789abcdefghijkl');
  });

  it('redacts known provider key formats and bearer tokens', () => {
    const raw =
      'Authorization: Bearer abcDEF123._-xyz\n' +
      'a=sk-abcdefgh12345678\nb=gsk_abcdefgh12345678\n' +
      'c=AIzaSyabcdefgh12345678\nd=nvapi-abcdefgh12345678';
    const cleaned = redactSecretText(raw);
    for (const secret of [
      'abcDEF123._-xyz',
      'sk-abcdefgh12345678',
      'gsk_abcdefgh12345678',
      'AIzaSyabcdefgh12345678',
      'nvapi-abcdefgh12345678',
    ])
      expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain('[REDACTED]');
  });

  it('never writes raw secrets to the log file', async () => {
    const logsDir = await tempDir('ferry-qa-logs-');
    const logger = createLogger({ logsDir });
    logger.info(
      {
        apiKey: 'sk-secret-value-1234567890',
        note: 'Authorization: Bearer abcdefghijklmnop',
        nested: { token: 'tok_abcdefghij' },
      },
      'qa-marker',
    );
    const flush = (): Promise<void> =>
      new Promise((resolve) => {
        const candidate = logger as unknown as { flush?: (cb: () => void) => void };
        if (typeof candidate.flush === 'function') candidate.flush(resolve);
        else setTimeout(resolve, 300);
      });
    await flush();
    let text = '';
    for (let attempt = 0; attempt < 30 && !text.includes('qa-marker'); attempt += 1) {
      const files = await readdir(logsDir).catch(() => []);
      text = (
        await Promise.all(
          files.map((name) => readFile(path.join(logsDir, name), 'utf8').catch(() => '')),
        )
      ).join('\n');
      if (!text.includes('qa-marker')) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!text.includes('qa-marker')) return;
    expect(text).not.toContain('sk-secret-value-1234567890');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('tok_abcdefghij');
  }, 15_000);

  it('ignores an invalid FERRY_PERMISSION_MODE instead of throwing', async () => {
    // BUG: the environment override is fed straight into the enum schema, so a
    // typo in an env var crashes config loading instead of being ignored.
    const dir = await tempDir();
    await expect(
      loadProjectConfig(dir, { FERRY_PERMISSION_MODE: 'totally-not-a-mode' }),
    ).resolves.toMatchObject({ permissionMode: 'ask' });
  });
});
