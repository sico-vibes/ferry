import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMain, unchanged, nodeTests, texts, blog, responsive } from '../../lib/checker.mjs';
import { run } from '../../lib/process.mjs';
const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));
await checkMain(async (dir) => {
  await unchanged(dir, fixture, ['test_stats.py']);
  let python;
  for (const command of ['python3', 'python', 'py']) {
    const result = await run(command, ['--version']);
    if (result.code === 0) {
      python = command;
      break;
    }
  }
  if (!python) return { status: 'skipped', reason: 'skipped: no Python' };
  const result = await run(python, ['-m', 'unittest', 'test_stats.py'], {
    cwd: dir,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
});
