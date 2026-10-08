import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { options } from './lib/options.mjs';
import { metrics, freeModels } from './lib/metrics.mjs';
import { environment, cliCommand, remove } from './lib/live.mjs';
import { loadTasks, check, selfTestTasks } from './lib/tasks.mjs';
import { report } from './lib/report.mjs';
import { run } from './lib/process.mjs';
import { transportModel } from './lib/large-reply.mjs';

// Standalone offline integration suite. Every spawned command has a deadline;
// browser DevTools traffic is loopback only, and pages block external requests.
assert.throws(() => options([]), /explicit|require/);
assert.throws(() => options(['--keys-from-env', '--use-stored-keys']), /one key/);
assert.throws(() => options(['--dry-run', '--repeat', '0']), /positive/);
assert.throws(() => options(['--dry-run', '--tasks']), /Missing/);
assert.throws(() => options(['--surprise']), /Unknown/);
assert.equal(options(['--dry-run']).profile, 'Auto-Free');
assert.equal(options(['--help']).help, true);
assert(
  !Object.keys(environment('Ferry-Bench-Test')).some((name) => name.startsWith('FERRY_LIVE_')),
);
assert.equal(environment('Ferry-Bench-Test').FERRY_KEYRING_SERVICE, 'Ferry-Bench-Test');
assert.deepEqual(cliCommand('/tmp/ferry.js', ['run', "a 'quoted' prompt"]), [
  process.execPath,
  ['/tmp/ferry.js', 'run', "a 'quoted' prompt"],
]);

const usage = { id: 'usage1', type: 'usage', inputTokens: 10, outputTokens: 3, reasoningTokens: 2 };
const attempt = { id: 'attempt1', model: 'groq/a', errorKind: 'invalid_request', status: 400 };
const tool = {
  id: 'tool1',
  type: 'tool_call',
  tool: 'list_dir',
  status: 'pending',
  producedBy: 'groq/a',
};
const parsed = metrics(
  [
    { type: 'session.part', part: tool },
    { type: 'session.part', part: { ...tool, status: 'succeeded' } },
    {
      type: 'session.part',
      part: {
        id: 'handoff1',
        type: 'handoff_marker',
        from: 'groq/a',
        to: 'cerebras/b',
        reason: 'error',
        explanation: 'HTTP 400',
      },
    },
    { type: 'session.message', message: { role: 'assistant', modelAttempts: [attempt] } },
    {
      type: 'session.status',
      session: { status: 'running', waitUntil: '2026-01-01T00:00:00Z', agentEvents: [usage] },
    },
    { type: 'session.status', session: { status: 'idle', agentEvents: [usage] } },
    { type: 'run.completed', servedModel: 'cerebras/b', attempts: [attempt] },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n'),
);
assert.equal(parsed.steps, 1);
assert.equal(parsed.toolCalls[0].status, 'succeeded');
assert.equal(parsed.switches.length, 1);
assert.equal(parsed.waits.length, 1);
assert.deepEqual(parsed.failedAttemptsByKind, { invalid_request: 1 });
assert.deepEqual(parsed.tokens, { input: 10, output: 3, reasoning: 2 });
assert.equal(parsed.finalOutcome, 'idle');
assert.equal(parsed.completed, true);
assert.equal(metrics('not json\n').malformedLines, 1);
assert.equal(metrics('null\n[]\n"text"\n').malformedLines, 3);
assert.equal(metrics('').tokens, null);
assert.deepEqual(
  metrics(
    JSON.stringify({
      type: 'run.completed',
      usage: { inputTokens: 7, outputTokens: 2, reasoningTokens: 1 },
    }),
  ).tokens,
  { input: 7, output: 2, reasoning: 1 },
);
const model = {
  ref: 'groq/a',
  providerId: 'groq',
  toolCalling: true,
  priceInPerM: 1,
  priceOutPerM: 1,
};
const provider = {
  id: 'groq',
  tag: 'legit',
  freePlan: { models: ['*'] },
  availableModels: [model],
};
assert.equal(freeModels(provider).length, 1);
assert.equal(freeModels({ ...provider, billingEnabled: true }).length, 0);
assert.equal(
  freeModels({ ...provider, freePlan: { models: ['*'], excludedModels: ['a'] } }).length,
  0,
);
assert.equal(
  freeModels({
    ...provider,
    availableModels: Array.from({ length: 4 }, (_, i) => ({ ...model, ref: `groq/${i}` })),
  }).length,
  3,
);
assert.equal(freeModels({ ...provider, tag: 'trial' }).length, 0);
const large = transportModel('groq');
assert.equal(large.ref, 'groq/ferry-transport-only');
assert.equal(large.toolCalling, false);
assert.equal(large.free, false);
assert(Buffer.byteLength(JSON.stringify(large)) > 1_000_000);

await assert.rejects(() => loadTasks('../outside'), /Unknown/);
const tasks = await loadTasks();
assert.equal(tasks.length, 10);
const results = await selfTestTasks();
const temporary = await mkdtemp(join(tmpdir(), 'ferry-bench-test-'));
try {
  const task = tasks.find((item) => item.id === 'fix-failing-test');
  const workspace = join(temporary, 'tampered');
  await cp(join(task.dir, 'solution'), workspace, { recursive: true });
  await writeFile(join(workspace, 'test.mjs'), '// deleted assertions\n');
  const checked = await check(task, workspace);
  assert.equal(checked.status, 'fail');
  assert.match(checked.reason, /Protected file changed/);
  const output = join(temporary, 'report.json');
  const data = await report(
    output,
    [
      { task: 'a', status: 'pass' },
      { task: 'b', status: 'fail' },
      { task: 'c', status: 'skipped' },
    ],
    'bench',
  );
  assert.equal(data.successRate, 0.5);
  assert.deepEqual(data.counts, { pass: 1, fail: 1, skipped: 1 });
  assert.match(await readFile(join(temporary, 'report.md'), 'utf8'), /50.0%/);
  const timedOut = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 250,
  });
  assert.equal(timedOut.timedOut, true);
  const missing = await run(join(temporary, 'missing-command'), []);
  assert.notEqual(missing.code, 0);
  const browserTask = tasks.find((item) => item.id === 'blog-html');
  const unavailable = await check(browserTask, workspace, {
    env: { ...environment('Ferry-Bench-Checker'), BENCH_CHROMIUM: join(temporary, 'no-chromium') },
  });
  assert.equal(unavailable.status, 'skipped');
  assert.equal(unavailable.checkerExitCode, 77);
  assert.match(unavailable.reason, /skipped: no Chromium/);
} finally {
  await remove(temporary);
}
console.log(
  `bench:self-test: ${results.filter((row) => row.status === 'pass').length} task solutions passed; ${results.filter((row) => row.status === 'skipped').length} skipped; parser/options/process/report checks passed`,
);
