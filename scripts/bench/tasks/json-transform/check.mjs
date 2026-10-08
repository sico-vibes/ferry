import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMain, unchanged, nodeTests, texts, blog, responsive } from '../../lib/checker.mjs';
import { run } from '../../lib/process.mjs';
const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));
await checkMain(async (dir) => {
  await unchanged(dir, fixture, ['input.json', 'expected.json', 'package.json']);
  const result = await run(process.execPath, ['transform.mjs'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    await readFile(join(fixture, 'expected.json'), 'utf8'),
    'Output must exactly equal expected.json',
  );
});
