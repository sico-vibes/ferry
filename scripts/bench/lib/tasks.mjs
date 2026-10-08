import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { root } from './options.mjs';
import { run } from './process.mjs';
import { remove, environment } from './live.mjs';

export async function loadTasks(selection) {
  const directory = join(root, 'scripts/bench/tasks');
  const ids = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const selected = selection ? selection.split(',') : ids;
  assert(
    selected.length && selected.every((id) => ids.includes(id)),
    `Unknown task selection: ${selection}`,
  );
  const tasks = [];
  for (const id of selected) {
    const dir = join(directory, id);
    const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'));
    assert.equal(task.id, id);
    assert(typeof task.prompt === 'string' && task.prompt.trim(), `${id}: prompt required`);
    assert(
      task.profile === null || (typeof task.profile === 'string' && task.profile.trim()),
      `${id}: profile must be null or a name`,
    );
    assert(Number.isSafeInteger(task.maxSteps) && task.maxSteps > 0, `${id}: invalid maxSteps`);
    assert(Number.isSafeInteger(task.timeoutMs) && task.timeoutMs > 0, `${id}: invalid timeoutMs`);
    assert(
      !task.requires || ['python', 'chromium'].includes(task.requires),
      `${id}: unsupported requirement`,
    );
    for (const field of ['fixture', 'checker']) {
      assert(typeof task[field] === 'string' && task[field], `${id}: missing ${field}`);
      const path = resolve(dir, task[field]);
      const rel = relative(dir, path);
      assert(rel && !rel.startsWith('..') && !isAbsolute(rel), `${id}: unsafe ${field}`);
      await access(path);
    }
    assert((await readdir(join(dir, task.fixture))).length, `${id}: empty fixture`);
    await access(join(dir, 'solution'));
    tasks.push({ ...task, dir });
  }
  return tasks;
}

export async function check(task, workspace, settings = {}) {
  const result = await run(process.execPath, [join(task.dir, task.checker), workspace], {
    cwd: workspace,
    timeoutMs: 90_000,
    env: environment('Ferry-Bench-Checker'),
    ...settings,
  });
  const status =
    result.code === 77 ? 'skipped' : result.code === 0 && !result.timedOut ? 'pass' : 'fail';
  return {
    status,
    reason: (result.stdout + result.stderr).trim(),
    checkerExitCode: result.code,
    checkerTimedOut: result.timedOut,
  };
}

export async function selfTestTasks(selection) {
  const tasks = await loadTasks(selection);
  const results = [];
  for (const task of tasks) {
    const temporary = await mkdtemp(join(tmpdir(), 'ferry-bench-self-test-'));
    try {
      const goodDir = join(temporary, 'good');
      const badDir = join(temporary, 'bad');
      await cp(join(task.dir, 'solution'), goodDir, { recursive: true });
      await cp(join(task.dir, task.fixture), badDir, { recursive: true });
      const good = await check(task, goodDir);
      const bad = await check(task, badDir);
      if (good.status === 'skipped' || bad.status === 'skipped') {
        assert.equal(good.status, 'skipped', `${task.id}: inconsistent skip`);
        assert.equal(bad.status, 'skipped', `${task.id}: inconsistent skip`);
        results.push({ task: task.id, repeat: 1, status: 'skipped', reason: good.reason });
      } else {
        assert.equal(good.status, 'pass', `${task.id}: solution failed: ${good.reason}`);
        assert.equal(bad.status, 'fail', `${task.id}: untouched fixture incorrectly passed`);
        assert.equal(
          bad.checkerTimedOut,
          false,
          `${task.id}: fixture rejection must not depend on timeout`,
        );
        results.push({
          task: task.id,
          repeat: 1,
          status: 'pass',
          reason: 'Solution passed; untouched fixture rejected',
        });
      }
      console.log(`${task.id}: ${results.at(-1).status} (${results.at(-1).reason})`);
    } finally {
      await remove(temporary);
    }
  }
  return results;
}
