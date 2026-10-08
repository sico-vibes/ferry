import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { checkMain, unchanged, nodeTests, texts, blog, responsive } from '../../lib/checker.mjs';
import { run } from '../../lib/process.mjs';
const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));
await checkMain(async (dir) => {
  await unchanged(dir, fixture, ['test.mjs', 'SPEC.md', 'package.json']);
  await nodeTests(dir);
  const api = await import(pathToFileURL(join(dir, 'index.mjs')));
  for (const name of [
    'createInventory',
    'search',
    'summary',
    'exportCsv',
    'save',
    'load',
    'render',
  ])
    assert.equal(typeof api[name], 'function', 'Missing public export ' + name);
});
