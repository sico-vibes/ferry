import { readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const resultPath = resolve(repositoryRoot, 'docs/perf-results.json');
const markdownPath = resolve(repositoryRoot, 'docs/PERFORMANCE.md');
const run = (label, command, args) =>
  new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });
    child.once('error', (error) =>
      resolveRun({ label, exitCode: null, error: error.message, stdout, stderr }),
    );
    child.once('close', (exitCode) => resolveRun({ label, exitCode, stdout, stderr }));
  });
const parseResults = (output) =>
  output.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return typeof value === 'object' && value !== null && 'benchmark' in value ? [value] : [];
    } catch {
      return [];
    }
  });

const steps = [
  ['desktop-package', process.execPath, ['scripts/dist.mjs']],
  ['packaged-startup', process.execPath, ['scripts/perf-startup.mjs']],
  ['long-transcript', process.execPath, ['scripts/perf-long-transcript.mjs']],
  ['large-workspace', process.execPath, ['--import', 'tsx', 'scripts/perf-workspace.mjs']],
  ['screen-renders', process.execPath, ['scripts/perf-render.mjs']],
];
const runs = [];
for (const [label, command, args] of steps) runs.push(await run(label, command, args));

let manifest = {};
try {
  manifest = JSON.parse(
    await readFile(resolve(packageRoot, 'out/renderer/.vite/manifest.json'), 'utf8'),
  );
} catch {
  // Keep partial results when a build could not produce a manifest.
}
const chunks = await Promise.all(
  Object.values(manifest)
    .filter((entry) => typeof entry.file === 'string' && entry.file.endsWith('.js'))
    .map(async (entry) => ({
      file: entry.file,
      bytes: (await stat(resolve(packageRoot, 'out/renderer', entry.file))).size,
    })),
);
const benchmarks = runs.flatMap((item) => parseResults(item.stdout));
const find = (name) => benchmarks.find((item) => item.benchmark === name);
const startup = find('packaged-startup');
const longTranscript = find('long-transcript');
const workspace = find('large-workspace');
const renderResult = find('screen-renders');
const result = {
  generatedAt: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch, node: process.version },
  startup: startup ? { warmInteractiveMs: startup.warmInteractiveMs, idle: startup.idle } : null,
  p2IdleCpuComparison: {
    before: null,
    beforeNote:
      'The prior baseline did not collect CPU metrics; capture it from the pre-P2 revision.',
    after: startup?.idle ?? null,
  },
  longTranscript,
  workspace,
  renders: renderResult?.renders ?? null,
  bundle: {
    chunks,
    totalJsBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
  },
  runs: runs.map(({ label, exitCode, error }) => ({
    label,
    exitCode,
    ...(error ? { error } : {}),
  })),
};
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
const rows = [
  ['Warm startup TTI', startup?.warmInteractiveMs, 'ms'],
  ['P2 idle CPU before', 'not captured by the prior baseline', '60 s average'],
  [
    'Idle CPU after startup',
    startup?.idle?.afterStartup?.processes
      ?.map((item) => `${item.role} ${item.averageCpuPercent ?? 'n/a'}%`)
      .join(', '),
    '60 s average',
  ],
  [
    'Idle CPU after session',
    startup?.idle?.afterSession?.processes
      ?.map((item) => `${item.role} ${item.averageCpuPercent ?? 'n/a'}%`)
      .join(', '),
    '60 s average',
  ],
  [
    'Process RSS after startup',
    startup?.idle?.afterStartup?.processes
      ?.map((item) => `${item.role} ${item.rssBytes ?? 'n/a'} B`)
      .join(', '),
    'bytes',
  ],
  [
    'Process RSS after session',
    startup?.idle?.afterSession?.processes
      ?.map((item) => `${item.role} ${item.rssBytes ?? 'n/a'} B`)
      .join(', '),
    'bytes',
  ],
  ['10k transcript append', longTranscript?.appendMs, 'ms'],
  [
    '50k workspace grep',
    workspace?.operations?.find((item) => item.name === 'grep')?.elapsedMs,
    'ms',
  ],
  ['DB query sample', startup?.dbQuerySample?.elapsedMs, 'ms (sessions.list RPC)'],
  ['Renderer JavaScript bundle', result.bundle.totalJsBytes, 'bytes'],
  ['Home render commits', renderResult?.renders?.Home, 'dev Profiler'],
  ['Session render commits', renderResult?.renders?.Session, 'dev Profiler'],
  ['Explore render commits', renderResult?.renders?.Explore, 'dev Profiler'],
  ['Settings render commits', renderResult?.renders?.Settings, 'dev Profiler'],
];
const table = [
  '| Measurement | Result | Unit |',
  '|---|---:|---|',
  ...rows.map(([name, value, unit]) => `| ${name} | ${value ?? 'not captured'} | ${unit} |`),
].join('\n');
const chunkTable = [
  '| Renderer chunk | Bytes |',
  '|---|---:|',
  ...chunks.map(({ file, bytes }) => `| ${file} | ${bytes} |`),
].join('\n');
const section = `\n\n## Wave P baseline (generated ${result.generatedAt})\n\n${table}\n\n### Renderer chunks\n\n${chunkTable}\n\nMachine-readable output: [perf-results.json](perf-results.json).\n`;
let currentDoc = await readFile(markdownPath, 'utf8');
const sectionStart = currentDoc.indexOf('\n## Wave P baseline');
if (sectionStart >= 0) currentDoc = currentDoc.slice(0, sectionStart);
await writeFile(markdownPath, `${currentDoc.trimEnd()}${section}`, 'utf8');
console.log(`Wrote ${resultPath} and updated ${markdownPath}.`);
if (runs.some((item) => item.exitCode !== 0)) process.exitCode = 1;
