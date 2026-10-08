import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const cell = (value) =>
  String(value ?? '-')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]/g, ' ');
export async function report(out, rows, kind, extra = {}) {
  const counts = { pass: 0, fail: 0, skipped: 0 };
  for (const row of rows) counts[row.status]++;
  const measured = counts.pass + counts.fail;
  const data = {
    schemaVersion: 1,
    kind,
    generatedAt: new Date().toISOString(),
    counts,
    successRate: measured ? counts.pass / measured : null,
    ...extra,
    runs: rows,
  };
  const headers =
    kind === 'bench'
      ? [
          'Task',
          'Repeat',
          'Result',
          'Seconds',
          'Steps',
          'Models',
          'Switches',
          'Waits',
          'Failed attempts',
          'Tokens',
          'Exit',
          'Outcome / reason',
        ]
      : ['Provider', 'Model', 'Run', 'Result', 'Failure kind', 'HTTP', 'Latency ms', 'Reason'];
  const values = (row) =>
    kind === 'bench'
      ? [
          row.task,
          row.repeat,
          row.status,
          ((row.durationMs ?? 0) / 1000).toFixed(1),
          row.steps,
          row.modelsUsed?.join(', '),
          row.switches?.length,
          row.waits?.length,
          JSON.stringify(row.failedAttemptsByKind ?? {}),
          row.tokens ? row.tokens.input + row.tokens.output : '-',
          row.cliExitCode,
          row.reason ?? row.finalOutcome,
        ]
      : [
          row.provider,
          row.model,
          row.run,
          row.status,
          row.failureKind,
          row.statusCode,
          Math.round(row.durationMs ?? 0),
          row.reason,
        ];
  const markdown = `# Ferry ${kind}\n\nPassed: ${counts.pass}; failed: ${counts.fail}; skipped: ${counts.skipped}. Success rate: ${measured ? `${(100 * data.successRate).toFixed(1)}%` : 'not measured'}.\n\n| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((row) => `| ${values(row).map(cell).join(' | ')} |`).join('\n')}\n`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(out.replace(/\.json$/i, '') + '.md', markdown);
  return data;
}
