/* eslint
  @typescript-eslint/no-non-null-assertion: off,
  @typescript-eslint/require-await: off
*/
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editFile } from '../src/edit.js';
import { findForgivingEdit } from '../src/forgiving-edit.js';
import { WorkspaceTools } from '../src/tools.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    return new Error('Expected the call to reject');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ferry-qa-weak-ws-'));
  tempDirs.push(root);
  return root;
}

describe('QA weak workspace: ambiguous matches must never edit silently', () => {
  it('refuses an exact edit that occurs more than once and leaves the file untouched', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(root);
    const file = path.join(root, 'dup.txt');
    await writeFile(file, 'value\nvalue\n', 'utf8');
    await expect(
      editFile(tools, { path: 'dup.txt', edits: [{ search: 'value', replace: 'x' }] }),
    ).rejects.toThrow(/ambiguous/i);
    expect(await readFile(file, 'utf8')).toBe('value\nvalue\n');
  });

  it('refuses an edit whose only matches are normalized (whitespace-insensitive)', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(root);
    const content = '  alpha \n beta \n  alpha \n beta \n';
    const file = path.join(root, 'norm.txt');
    await writeFile(file, content, 'utf8');
    expect(findForgivingEdit(content, 'alpha\nbeta')?.count).toBeGreaterThan(1);
    await expect(
      editFile(tools, { path: 'norm.txt', edits: [{ search: 'alpha\nbeta', replace: 'z' }] }),
    ).rejects.toThrow(/ambiguous/i);
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it.fails('rejects a disproportionate fuzzy match instead of deleting a huge region', async () => {
    // BUG: findForgivingEdit's whitespace-normalizing fallbacks (normalizers[1..])
    // have no equivalent of the block-anchor disproportion guard, so a 7-character
    // search matches a whitespace run of any length; editFile then replaces the
    // whole region.
    const root = await workspace();
    const tools = new WorkspaceTools(root);
    const original = 'foo' + ' '.repeat(2000) + 'bar';
    await writeFile(path.join(root, 'big.txt'), original, 'utf8');
    const match = findForgivingEdit(original, 'foo bar');
    expect(match === undefined || match.end - match.start <= 10).toBe(true);
    const change = await editFile(tools, {
      path: 'big.txt',
      edits: [{ search: 'foo bar', replace: 'X' }],
    });
    expect(change.after).toBe(original);
  });

  it.fails('treats overlapping occurrences as ambiguous', () => {
    // BUG: occurrences() advances by needle.length, so overlapping matches are
    // invisible; "aa" inside "aaa" is reported as a single unambiguous match.
    expect(findForgivingEdit('aaa', 'aa')?.count).toBeGreaterThan(1);
  });

  it('guards the block-anchor match against a disproportionate span', () => {
    const text = ['start', ...Array.from({ length: 500 }, () => 'filler'), 'end'].join('\n');
    const match = findForgivingEdit(text, 'start\nend');
    expect(match === undefined || match.end - match.start < 100).toBe(true);
  });
});

describe('QA weak workspace: encodings, line endings and unicode', () => {
  it('preserves CRLF endings and uses them for newly inserted lines', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(root);
    const file = path.join(root, 'crlf.txt');
    await writeFile(file, 'one\r\ntwo\r\nthree\r\n', 'utf8');
    const change = await editFile(tools, {
      path: 'crlf.txt',
      edits: [{ search: 'two', replace: 'TWO\nEXTRA' }],
    });
    expect(change.after).toBe('one\r\nTWO\r\nEXTRA\r\nthree\r\n');
    expect(await readFile(file, 'utf8')).toBe('one\r\nTWO\r\nEXTRA\r\nthree\r\n');
  });

  it('preserves a UTF-8 BOM through an edit', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(root);
    const file = path.join(root, 'bom.txt');
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\ntwo\n', 'utf8')]),
    );
    const change = await editFile(tools, {
      path: 'bom.txt',
      edits: [{ search: 'two', replace: 'TWO' }],
    });
    expect(change.after).toBe('one\nTWO\n');
    const raw = await readFile(file);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.subarray(3).toString('utf8')).toBe('one\nTWO\n');
  });

  it('preserves UTF-16LE with a BOM through an edit', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(root);
    const file = path.join(root, 'u16.txt');
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('one\ntwo\n', 'utf16le')]),
    );
    const change = await editFile(tools, {
      path: 'u16.txt',
      edits: [{ search: 'two', replace: 'TWO' }],
    });
    expect(change.after).toBe('one\nTWO\n');
    const raw = await readFile(file);
    expect([...raw.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(raw.subarray(2).toString('utf16le')).toBe('one\nTWO\n');
  });

  it('matches edits across tabs, spaces, unicode and emoji', () => {
    expect(findForgivingEdit('\tconst s = "🎉";', 'const s = "🎉";')?.snippet).toBe(
      'const s = "🎉";',
    );
    const spaced = findForgivingEdit('const a = 1;\nconst b = 2;', 'const a   =   1;');
    expect(spaced?.count).toBe(1);
    expect(spaced?.snippet.replace(/\s+/g, ' ')).toBe('const a = 1;');
  });

  it('edits a large file with a unique match', async () => {
    const root = await workspace();
    const tools = new WorkspaceTools(root);
    const big = Array.from({ length: 20_000 }, (_, index) => `line ${String(index)}`).join('\n');
    await writeFile(path.join(root, 'big.txt'), big, 'utf8');
    const change = await editFile(tools, {
      path: 'big.txt',
      edits: [{ search: 'line 12345', replace: 'LINE' }],
    });
    expect(change.after).toContain('LINE');
    expect(change.after).not.toContain('line 12345');
  });
});

describe('QA weak workspace: repair hints stay inside the jail', () => {
  it('never includes out-of-jail content in a jail error or a repair hint', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ferry-qa-weak-jail-'));
    tempDirs.push(base);
    const root = path.join(base, 'ws');
    await mkdir(root, { recursive: true });
    const tools = new WorkspaceTools(root);
    const secret = 'OUTSIDE-SECRET-7f3a';
    await writeFile(path.join(base, 'secret.txt'), secret, 'utf8');
    await writeFile(path.join(root, 'inside.txt'), 'inside line\n', 'utf8');

    const jailError = await rejectionOf(
      editFile(tools, {
        path: '../secret.txt',
        edits: [{ search: 'x', replace: 'y' }],
      }),
    );
    expect(jailError.message).not.toContain(secret);

    const hintError = await rejectionOf(
      editFile(tools, {
        path: 'inside.txt',
        edits: [{ search: 'not-here-at-all', replace: 'x' }],
      }),
    );
    expect(hintError.message).not.toContain(secret);
    expect(hintError.message).toContain('Closest actual line');
    expect(hintError.message).toContain('inside·line');
  });
});
