import { describe, expect, it, vi } from 'vitest';
import { collectDoctor } from '../src/doctor.js';

describe('doctor probes', () => {
  it('uses injected executable, module, and sqlite probes', async () => {
    const version = vi.fn((path: string) => Promise.resolve(`${path} 1.0`));
    const rows = await collectDoctor({
      resolveCommand: (name) => (name === 'claude' ? null : `/mock/${name}`),
      version,
      detectCli: (name, path) => Promise.resolve(`${name} detected at ${path}`),
      loadModule: (specifier) =>
        Promise.resolve(specifier === '@vscode/ripgrep' ? { rgPath: '/mock/rg' } : {}),
      openSqlite: () => Promise.resolve(),
      dataDirectory: '/mock/ferry',
      nodeVersion: 'v22.0.0',
      platform: 'linux',
    });
    expect(rows.find((row) => row.name === 'codex')).toMatchObject({
      status: 'ok',
      reason: 'codex detected at /mock/codex · /mock/codex',
    });
    expect(rows.find((row) => row.name === 'claude')).toMatchObject({ status: 'warn' });
    expect(rows.find((row) => row.name === 'SQLite')).toMatchObject({ status: 'ok' });
    expect(rows.find((row) => row.name === 'ripgrep')).toMatchObject({ status: 'ok' });
    expect(version).toHaveBeenCalledTimes(1);
    expect(version).toHaveBeenCalledWith('/mock/rg', ['--version'], 5000);
  });
});
