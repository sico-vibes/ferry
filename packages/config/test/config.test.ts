import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  getDataPaths,
  loadProjectConfig,
  loadSettings,
  saveSettings,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-config-'));
  dirs.push(dir);
  return dir;
}

describe('@ferry/config', () => {
  it('uses FERRY_HOME and creates versioned settings that migrate from v0', async () => {
    expect(getDataPaths({ FERRY_HOME: 'D:/Ferry' }, 'win32').db).toBe(win32.join('D:/Ferry', 'db'));
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await saveSettings(file, DEFAULT_SETTINGS);
    const stored = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      settings: unknown;
    };
    await writeFile(file, JSON.stringify({ version: 0, settings: stored.settings }));
    expect((await loadSettings({ filePath: file })).theme).toBe('system');
  });
  it('backs up invalid settings and applies project environment overrides', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '{invalid');
    const warn = vi.fn();
    expect(await loadSettings({ filePath: file, warn })).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledOnce();
    const config = await loadProjectConfig(dir, {
      FERRY_GATE_COMMANDS: 'npm test;npm lint',
      FERRY_PERMISSION_MODE: 'auto_edit',
    });
    expect(config.gateCommands).toEqual(['npm test', 'npm lint']);
    expect(config.permissionMode).toBe('auto_edit');
  });
});
