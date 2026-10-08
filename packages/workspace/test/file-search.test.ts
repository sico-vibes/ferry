import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fileNameScore, WorkspaceFileSearch } from '../src/index.js';

describe('file name ranking', () => {
  it('ranks exact names, prefixes, substrings and ordered fuzzy characters', () => {
    const names = ['needle', 'needle.ts', 'my-needle.ts', 'n-e-e-d-l-e.ts'];
    const scores = names.map((name) => fileNameScore(name, 'needle'));
    expect(scores.every((score) => score !== null)).toBe(true);
    expect(scores).toEqual([...scores].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)));
    expect(fileNameScore('unrelated.ts', 'needle')).toBeNull();
    expect(fileNameScore('anything', '')).toBe(0);
    expect(fileNameScore('el-deen', 'needle')).toBeNull();
  });
});

it('retains its file inventory until invalidated and handles empty folders', async () => {
  const temporaryRoot = fileURLToPath(new URL('../../../.dev/test-tmp/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'file-search-'));
  try {
    const search = new WorkspaceFileSearch();
    expect(await search.search(root, 'file')).toEqual([]);
    await writeFile(join(root, 'file.ts'), '');
    search.invalidate(root);
    expect(await search.search(root, ' FILE ')).toEqual([{ path: 'file.ts', name: 'file.ts' }]);
    await writeFile(join(root, 'file-new.ts'), '');
    expect(await search.search(root, 'file')).toHaveLength(1);
    search.invalidate(root);
    expect(await search.search(root, 'file')).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 30_000);
