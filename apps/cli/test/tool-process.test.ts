import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolProcess } from '../src/tool-process.js';
describe('Windows tool launch', () => {
  it('resolves an npm Node shim without using a shell or interpreting literal arguments', async () => {
    const root = fileURLToPath(new URL('../../../.dev/test-tmp/', import.meta.url));
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'tool-shim-'));
    try {
      await writeFile(
        join(directory, 'codex.cmd'),
        '@echo off\nif exist "%dp0%\\node.exe" (set node=node.exe)\n"%_prog%" "%dp0%\\codex.js" %*\n',
        'utf8',
      );
      await writeFile(join(directory, 'codex.js'), '// fixture\n', 'utf8');
      const args = ['exec', 'literal & "text" $(no command)'];
      const selected = await toolProcess(
        { command: 'codex', args, env: {} },
        { PATH: directory },
        'win32',
      );
      expect(selected).toEqual({
        command: process.execPath,
        args: [join(directory, 'codex.js'), ...args],
      });
      await writeFile(join(directory, 'opencode.cmd'), '"%_prog%" "%~dp0\\opencode" %*\n', 'utf8');
      await writeFile(join(directory, 'opencode'), '// fixture\n', 'utf8');
      expect(
        await toolProcess({ command: 'opencode', args: [], env: {} }, { PATH: directory }, 'win32'),
      ).toEqual({ command: process.execPath, args: [join(directory, 'opencode')] });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);
});
