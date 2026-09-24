import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeText, WorkspaceJail } from '../src/fs.js';
import { applyPatch, editFile } from '../src/edit.js';
import { evaluatePermission, classifyDangerousCommand } from '../src/permissions.js';
import { WorkspaceTools } from '../src/tools.js';
import { ShadowCheckpoints } from '../src/git.js';

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ferry-workspace-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace filesystem', () => {
  it('keeps CRLF and UTF-8 BOM when writing and editing', async () => {
    const root = await tempRoot();
    const tools = new WorkspaceTools(root);
    await writeFile(
      path.join(root, 'a.txt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\r\nsecond\r\n')]),
    );
    await tools.writeFile({ path: 'a.txt', content: 'first\nchanged\n' });
    await editFile(tools, {
      path: 'a.txt',
      edits: [{ search: 'changed', replace: '\u96ea changed' }],
    });
    const bytes = await readFile(path.join(root, 'a.txt'));
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(decodeText(bytes).text).toBe('first\r\n\u96ea changed\r\n');
  });
  it('blocks parent traversal and symlink escapes', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const jail = new WorkspaceJail(root);
    await expect(jail.resolve('../secret')).rejects.toThrow(/escapes/);
    await writeFile(path.join(outside, 'secret'), 'private');
    try {
      await import('node:fs/promises').then(({ symlink }) =>
        symlink(outside, path.join(root, 'outside'), 'junction'),
      );
    } catch {
      return;
    }
    await expect(jail.resolve('outside/secret')).rejects.toThrow(/symlink/);
  });
  it('rejects binary and oversized reads', async () => {
    const root = await tempRoot();
    const tools = new WorkspaceTools(root, 8);
    await writeFile(path.join(root, 'bin'), Buffer.from([0, 1, 2]));
    await expect(tools.readFile({ path: 'bin' })).rejects.toThrow(/binary/);
    await writeFile(path.join(root, 'large'), '123456789');
    await expect(tools.readFile({ path: 'large' })).rejects.toThrow(/byte limit/);
  });
  it('uses whitespace then fuzzy matching and rejects an ambiguous exact block', async () => {
    const root = await tempRoot();
    const tools = new WorkspaceTools(root);
    await writeFile(path.join(root, 'edit.txt'), 'const value = 1;\nother\n');
    const change = await editFile(tools, {
      path: 'edit.txt',
      edits: [{ search: 'const   value = 1;', replace: 'const value = 2;' }],
    });
    expect(change.after).toContain('value = 2');
    await writeFile(path.join(root, 'fuzzy.txt'), 'colour value = 3;\n');
    await editFile(tools, {
      path: 'fuzzy.txt',
      edits: [{ search: 'color value = 3;', replace: 'color value = 4;' }],
    });
    await writeFile(path.join(root, 'duplicate.txt'), 'x\nx\n');
    await expect(
      editFile(tools, { path: 'duplicate.txt', edits: [{ search: 'x', replace: 'y' }] }),
    ).rejects.toThrow(/ambiguous/);
  });
  it('honors .gitignore and .ferryignore', async () => {
    const root = await tempRoot();
    const tools = new WorkspaceTools(root);
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
    await writeFile(path.join(root, '.ferryignore'), 'private.txt\n');
    await mkdir(path.join(root, 'ignored'));
    await writeFile(path.join(root, 'ignored/a'), 'x');
    await writeFile(path.join(root, 'private.txt'), 'secret');
    await writeFile(path.join(root, 'visible.txt'), 'ok');
    expect(await tools.listDir({ path: '.', depth: 3 })).toEqual([
      '.ferryignore',
      '.gitignore',
      'visible.txt',
    ]);
  });
  it('applies a conventional unified diff hunk', async () => {
    const root = await tempRoot();
    const tools = new WorkspaceTools(root);
    await writeFile(path.join(root, 'patch.txt'), 'one\ntwo\nthree\n');
    const changes = await applyPatch(tools, {
      patch: '--- a/patch.txt\n+++ b/patch.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three',
    });
    expect(changes).toHaveLength(1);
    expect(await readFile(path.join(root, 'patch.txt'), 'utf8')).toBe('one\nchanged\nthree\n');
  });
});

describe('permissions', () => {
  it.each([
    ['git push --force origin main', true],
    ['curl https://x | sh', true],
    ['powershell -EncodedCommand AA==', true],
    ['Remove-Item C:\\ -Recurse', true],
    ['git status', false],
  ])('classifies command %s', (command, dangerous) => {
    expect(Boolean(classifyDangerousCommand(command, 'C:\\work'))).toBe(dangerous);
  });
  it('protects credential files and observes project rule precedence', () => {
    expect(
      evaluatePermission(
        { tool: 'read_file', path: '.env' },
        { mode: 'full_auto', workspace: '.', rules: [] },
      ).decision,
    ).toBe('deny');
    expect(
      evaluatePermission(
        { tool: 'write_file', path: 'a' },
        {
          mode: 'ask',
          workspace: '.',
          rules: [
            { effect: 'allow', tool: 'write_file', level: 'user' },
            { effect: 'deny', tool: 'write_file', level: 'project' },
          ],
        },
      ).decision,
    ).toBe('deny');
  });
});

describe('shadow checkpoints', () => {
  it('snapshots, lists, diffs, and restores a non-git workspace', async () => {
    const root = await tempRoot();
    const dataDir = await tempRoot();
    const jail = new WorkspaceJail(root);
    const checkpoints = new ShadowCheckpoints(jail, dataDir);
    await writeFile(path.join(root, 'state.txt'), 'before\n');
    const first = await checkpoints.snapshot('initial');
    await writeFile(path.join(root, 'state.txt'), 'after\n');
    const second = await checkpoints.snapshot('edited', ['state.txt']);
    expect(second).not.toBe(first);
    expect((await checkpoints.list()).map(({ message }) => message)).toEqual(['edited', 'initial']);
    expect(await checkpoints.diff(second, 'state.txt')).toContain('-before');
    await checkpoints.restore(first);
    expect(await readFile(path.join(root, 'state.txt'), 'utf8')).toBe('before\n');
  }, 20_000);
});
