import { cp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { options, usage } from './lib/options.mjs';
import { loadTasks, check, selfTestTasks } from './lib/tasks.mjs';
import { withLive } from './lib/live.mjs';
import { metrics } from './lib/metrics.mjs';
import { report } from './lib/report.mjs';
import { chromiumExecutable } from './lib/chromium.mjs';
import { run } from './lib/process.mjs';

try {
  const opts = options(process.argv.slice(2));
  if (opts.help) console.log(usage);
  else if (opts['dry-run'])
    await report(opts.out, await selfTestTasks(opts.tasks), 'bench', { dryRun: true });
  else {
    const tasks = await loadTasks(opts.tasks);
    const rows = [];
    try {
      for (let repeat = 1; repeat <= opts.repeat; repeat++)
        for (const task of tasks) {
          let unavailable;
          if (task.requires === 'chromium' && !(await chromiumExecutable()))
            unavailable = 'skipped: no Chromium';
          if (task.requires === 'python') {
            let available = false;
            for (const command of ['python3', 'python', 'py'])
              if ((await run(command, ['--version'])).code === 0) {
                available = true;
                break;
              }
            if (!available) unavailable = 'skipped: no Python';
          }
          if (unavailable)
            rows.push({ task: task.id, repeat, status: 'skipped', reason: unavailable });
          else
            await withLive(opts, async (live) => {
              if (live.skipped) {
                rows.push({ task: task.id, repeat, status: 'skipped', reason: live.skipped });
                return;
              }
              const workspace = join(live.temporary, 'workspace');
              await cp(join(task.dir, task.fixture), workspace, { recursive: true });
              const profile = task.profile ?? opts.profile;
              const result = await live.invoke(
                [
                  'run',
                  task.prompt,
                  '--json',
                  '--cwd',
                  workspace,
                  '--profile',
                  profile,
                  '--permission',
                  'full_auto',
                  '--max-steps',
                  String(task.maxSteps),
                ],
                { timeoutMs: task.timeoutMs },
              );
              const parsed = metrics(result.stdout);
              const checked = await check(task, workspace, { env: live.env });
              const checker = { ...checked, reason: live.scrub(checked.reason) };
              if (opts['keep-output']) {
                // Keep what the agent built and its event stream (secrets scrubbed) for review.
                const kept = join(opts['keep-output'], `${task.id}-${String(repeat)}`);
                await rm(kept, { recursive: true, force: true });
                await cp(workspace, kept, { recursive: true });
                await writeFile(join(kept, 'run.jsonl'), live.scrub(result.stdout), 'utf8');
              }
              const status =
                checker.status === 'skipped'
                  ? 'skipped'
                  : checker.status === 'pass' &&
                      result.code === 0 &&
                      !result.timedOut &&
                      parsed.completed &&
                      !parsed.malformedLines
                    ? 'pass'
                    : 'fail';
              rows.push({
                task: task.id,
                repeat,
                profile,
                ...parsed,
                ...checker,
                status,
                reason:
                  status === 'pass'
                    ? 'Checker passed'
                    : result.timedOut
                      ? 'CLI timeout'
                      : checker.status === 'pass'
                        ? `CLI did not finish successfully (exit ${result.code}, outcome ${parsed.finalOutcome})`
                        : checker.reason,
                durationMs: result.durationMs,
                cliExitCode: result.code,
                cliSignal: result.signal,
                timedOut: result.timedOut,
                stderr: result.stderr,
              });
            });
          console.log(`${task.id} #${repeat}: ${rows.at(-1).status}`);
          await report(opts.out, rows, 'bench', { profile: opts.profile });
        }
    } catch (error) {
      rows.push({ task: 'runner', repeat: null, status: 'fail', reason: error.message });
      throw error;
    } finally {
      await report(opts.out, rows, 'bench', { profile: opts.profile });
    }
    if (rows.some((row) => row.status === 'fail')) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
