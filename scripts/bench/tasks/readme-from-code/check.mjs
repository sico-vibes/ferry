import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMain, unchanged, nodeTests, texts, blog, responsive } from '../../lib/checker.mjs';
import { run } from '../../lib/process.mjs';
const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));
await checkMain(async (dir) => {
  await unchanged(dir, fixture, ['index.mjs', 'package.json']);
  const readme = await readFile(join(dir, 'README.md'), 'utf8');
  for (const pattern of [
    /slug/i,
    /clamp/i,
    /Node\s*(?:v)?22/i,
    /import\s*\{/i,
    /hello-ferry/i,
    /RangeError/,
    /min\s*>\s*max/i,
    /clamp\(12,\s*0,\s*10\)/,
  ])
    assert.match(readme, pattern, 'Missing API documentation');
});
