import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMain, unchanged, nodeTests, texts, blog, responsive } from '../../lib/checker.mjs';
import { run } from '../../lib/process.mjs';
const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));
await checkMain(async (dir) => {
  await unchanged(dir, fixture, ['test.mjs', 'SPEC.md', 'package.json']);
  await nodeTests(dir);
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  for (const pattern of [/<form/i, /localStorage/, /checkbox/, /delete/i, /<label/i])
    assert.match(html, pattern, 'Missing todo UI behavior');
});
