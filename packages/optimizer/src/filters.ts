import {
  keepOnlyIfSmaller,
  measured,
  type MeasuredOptimizerKind,
  type OptimizationResult,
} from './measurement.js';
import { defaultBlobStore, type BlobStore } from './recovery.js';

export interface FilterOptions {
  maxLines?: number;
  headLines?: number;
  tailLines?: number;
  sessionId?: string;
  blobStore?: BlobStore;
  benchmarkMode?: boolean;
}
export interface FilteredOutput extends OptimizationResult<string> {
  handle?: string;
}
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
function collapseProgress(input: string): string {
  return input
    .split(/\r?\n/)
    .map((line) => line.split('\r').at(-1) ?? '')
    .join('\n');
}
function foldDuplicates(lines: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const line = lines[i] ?? '';
    result.push(j - i > 1 ? `${line} (repeated ${String(j - i)} times)` : line);
    i = j;
  }
  return result;
}
function capLines(
  lines: string[],
  maxLines = 160,
  headLines = Math.ceil(maxLines / 2),
  tailLines = Math.floor(maxLines / 2),
): string[] {
  if (lines.length <= maxLines) return lines;
  const keepHead = Math.max(0, Math.min(headLines, maxLines - 1));
  const keepTail = Math.max(0, Math.min(tailLines, maxLines - keepHead - 1));
  return [
    ...lines.slice(0, keepHead),
    `... ${String(lines.length - keepHead - keepTail)} lines elided ...`,
    ...(keepTail ? lines.slice(-keepTail) : []),
  ];
}
export function genericFilter(input: string, options: FilterOptions = {}): string {
  const normalized = collapseProgress(input.replace(ANSI, '')).split(/\r?\n/);
  const candidate = capLines(
    foldDuplicates(normalized),
    options.maxLines,
    options.headLines,
    options.tailLines,
  ).join('\n');
  return keepOnlyIfSmaller(input, candidate);
}
function recoveryResult(
  kind: MeasuredOptimizerKind,
  original: string,
  output: string,
  options: FilterOptions,
): FilteredOutput {
  const event = measured(kind, original, output).event;
  const result: FilteredOutput = { output, event };
  if (output !== original) {
    const store = options.blobStore ?? defaultBlobStore;
    result.handle = store.put(options.sessionId ?? 'default', original);
  }
  return result;
}
export function filterToolOutput(
  command: string,
  input: string,
  options: FilterOptions = {},
): FilteredOutput {
  const kind = detectOutputKind(command);
  const candidate = options.benchmarkMode
    ? input
    : kind === 'git-status'
      ? filterGitStatus(input)
      : kind === 'git-diff'
        ? filterGitDiff(input)
        : kind === 'git-log'
          ? filterGitLog(input)
          : kind === 'test'
            ? filterTestOutput(input)
            : kind === 'build'
              ? filterBuildOutput(input)
              : kind === 'package-install'
                ? filterPackageInstall(input)
                : kind === 'filesystem'
                  ? filterFilesystem(input, options.maxLines ?? 100)
                  : genericFilter(input, options);
  const output = keepOnlyIfSmaller(input, candidate);
  const result = recoveryResult(
    options.benchmarkMode ? 'benchmark-bypass' : kind,
    input,
    output,
    options,
  );
  if (options.sessionId) result.event.sessionId = options.sessionId;
  result.event.timestamp = new Date().toISOString();
  return result;
}
export function optimizeOutput(
  command: string,
  input: string,
  options: FilterOptions = {},
): FilteredOutput {
  return filterToolOutput(command, input, options);
}
export function detectOutputKind(
  command: string,
):
  | 'git-status'
  | 'git-diff'
  | 'git-log'
  | 'test'
  | 'build'
  | 'package-install'
  | 'filesystem'
  | 'generic' {
  const cmd = command
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\s*&\s*/, '')
    .replace(/\.(?:cmd|exe)(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/(^|\s)(git\s+status|git\s+-c\s+[^ ]+\s+status)(\s|$)/.test(cmd)) return 'git-status';
  if (/(^|\s)git\s+diff(\s|$)/.test(cmd)) return 'git-diff';
  if (/(^|\s)git\s+log(\s|$)/.test(cmd)) return 'git-log';
  if (
    /(^|\s)(pnpm\s+(test|vitest)|npm\s+test|yarn\s+test|npx\s+(vitest|jest|mocha)|(?:vitest|jest|mocha|pytest|go\s+test|cargo\s+test))(\s|$)/.test(
      cmd,
    )
  )
    return 'test';
  if (/(^|\s)(tsc|eslint|ruff|cargo\s+build)(\s|$)/.test(cmd)) return 'build';
  if (/(^|\s)(npm|pnpm|yarn|pip)\s+(install|i|add)(\s|$)/.test(cmd)) return 'package-install';
  if (/(^|\s)(ls|dir|tree|gci|get-childitem)(\s|$)/.test(cmd) || cmd.includes('get-childitem'))
    return 'filesystem';
  return 'generic';
}
function gitStatusCandidate(input: string): string {
  const sections = new Map<string, string[]>();
  let section = 'Changes';
  let branch = '';
  for (const source of genericFilter(input, { maxLines: 1000 }).split('\n')) {
    const line = source.trim();
    if (!line) continue;
    if (line.startsWith('On branch ') || line.startsWith('## ')) {
      branch = line;
      continue;
    }
    if (line.startsWith('Changes to be committed:')) {
      section = 'Staged';
      continue;
    }
    if (line.startsWith('Changes not staged for commit:')) {
      section = 'Modified';
      continue;
    }
    if (line.startsWith('Untracked files:')) {
      section = 'Untracked';
      continue;
    }
    const porcelain = /^([ MADRCU?!]{1,2})\s+(.*)$/.exec(line);
    if (porcelain) {
      const status = porcelain[1] ?? '';
      section =
        status.includes('?') || status.includes('A')
          ? 'Added'
          : status.includes('D')
            ? 'Deleted'
            : status.includes('R')
              ? 'Renamed'
              : 'Modified';
      const paths = sections.get(section) ?? [];
      paths.push(porcelain[2] ?? '');
      sections.set(section, paths);
      continue;
    }
    const paths = sections.get(section) ?? [];
    paths.push(line.replace(/^modified:\s+/, '').replace(/^new file:\s+/, ''));
    sections.set(section, paths);
  }
  const groups = [...sections].map(
    ([name, paths]) =>
      `${name} (${String(paths.length)}):\n${paths.map((path) => `  ${path}`).join('\n')}`,
  );
  return [branch, ...groups].filter(Boolean).join('\n');
}
function gitDiffCandidate(input: string, context = 1): string {
  const lines = genericFilter(input, { maxLines: 10000 }).split('\n');
  const result: string[] = [];
  let inHunk = false;
  let hunk: string[] = [];
  const flush = (): void => {
    if (!hunk.length) return;
    const changed = hunk
      .map((line, index) => ({ line, index }))
      .filter((row) => row.line.startsWith('+') || row.line.startsWith('-'));
    const indexes = new Set<number>();
    for (const item of changed)
      for (
        let n = Math.max(0, item.index - context);
        n <= Math.min(hunk.length - 1, item.index + context);
        n++
      )
        indexes.add(n);
    let previous = -1;
    for (const n of [...indexes].sort((a, b) => a - b)) {
      if (previous >= 0 && n > previous + 1) result.push('  ... context elided ...');
      result.push(hunk[n] ?? '');
      previous = n;
    }
    hunk = [];
  };
  for (const line of lines) {
    if (
      line.startsWith('diff --stat') ||
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      flush();
      inHunk = false;
      result.push(line);
    } else if (line.startsWith('@@')) {
      flush();
      inHunk = true;
      result.push(line);
    } else if (inHunk) hunk.push(line);
    else if (line.startsWith('Binary files ')) result.push(line);
    else if (/^(?: .*\|\s+\d+| [0-9]+ files? changed| create mode| delete mode)/.test(line))
      result.push(line);
  }
  flush();
  return result.join('\n');
}
function gitLogCandidate(input: string): string {
  const result: string[] = [];
  let hash = '';
  let subject = '';
  const flush = (): void => {
    if (hash) result.push(`${hash}${subject ? ` ${subject}` : ''}`);
  };
  for (const line of input.split(/\r?\n/)) {
    const commit = /^commit\s+([0-9a-f]+)(?:\s+\((.*?)\))?/i.exec(line);
    if (commit) {
      flush();
      hash = `${commit[1] ?? ''}${commit[2] ? ` (${commit[2]})` : ''}`;
      subject = '';
      continue;
    }
    const trimmed = line.trim();
    if (hash && !subject && trimmed && !/^(Author:|Date:)/.test(trimmed)) subject = trimmed;
    else if (!hash && trimmed) result.push(trimmed);
  }
  flush();
  return result.join('\n');
}

function testCandidate(input: string): string {
  const lines = genericFilter(input, { maxLines: 2000 }).split('\n');
  const fail = lines.filter((line) =>
    /(^\s*(FAIL|FAILED|ERROR|not ok|✕|✗|×|âœ•|\.{2,}[FExX]|F\.|_{3,}|--- FAIL:|error:)|AssertionError|Traceback|Expected .*received|\bError:)/i.test(
      line,
    ),
  );
  const summary = lines.filter((line) =>
    /(Test Files|Tests\s+|Suites\s+|Snapshots\s+|Time\s+|passed|failed|skipped|no tests|All tests passed|ok\s+\S+\s+\(\d)/i.test(
      line,
    ),
  );
  if (
    /(All tests passed|Test Files\s+\d+ passed \(\d+\)|Tests\s+\d+ passed \(\d+\)|Tests:\s+\d+ passed,\s+\d+ total|\d+ passed(?:,\s+\d+ skipped)?(?: in [\d.]+s)?$)/im.test(
      input,
    ) &&
    !fail.length
  )
    return 'All tests passed.';
  const keptSet = new Set([...fail, ...summary]);
  const kept = lines
    .filter((line) => keptSet.has(line) && !/^\s*=+/.test(line))
    .map((line) => (/^\s*(?:❯|Test Files|Tests\s)/.test(line) ? line.trimStart() : line));
  return kept.length
    ? kept.join('\n')
    : /(passed|success|ok\s)/i.test(input)
      ? 'All tests passed.'
      : genericFilter(input, { maxLines: 30 });
}
function buildCandidate(input: string): string {
  const lines = genericFilter(input, { maxLines: 2000 }).split('\n');
  const errors = new Map<string, Set<string>>();
  const summary: string[] = [];
  for (const line of lines) {
    const m =
      /^(.+?\.(?:tsx?|jsx?|py|rs))(?::\d+(?::\d+)?)?:\s*(?:(error|warning|note)(?:\[[^\]]+\])?:\s*)?(.*)$/i.exec(
        line,
      );
    if (!m) {
      if (/(found \d+|no errors|finished|error\[|warning:|failed|successfully)/i.test(line))
        summary.push(line);
      continue;
    }
    const file = m[1] ?? '';
    const bucket = errors.get(file) ?? new Set<string>();
    bucket.add(`${m[2] ? `${m[2]}: ` : ''}${m[3] ?? ''}`);
    errors.set(file, bucket);
  }
  const result = [...errors].map(
    ([file, messages]) => `${file}:\n${[...messages].map((message) => `  ${message}`).join('\n')}`,
  );
  result.push(...summary);
  return result.length ? result.join('\n') : 'No build or lint diagnostics.';
}
function packageInstallCandidate(input: string): string {
  const lines = input.split(/\r?\n/);
  const errors = genericFilter(input, { maxLines: 2000 })
    .split('\n')
    .filter((line) =>
      /(^\s*(npm ERR!|ERR!|error:|ERROR:|failed|fatal|.*killed)|ELIFECYCLE|E[A-Z]{3,})/i.test(line),
    );
  const summary = lines.filter((line) =>
    /(added \d+ packages?|packages? installed|audited \d+ packages?|up to date|resolved \d+|downloaded \d+|saved \d+|installed successfully|requirements already satisfied|found \d+ vulnerabilities?)/i.test(
      line,
    ),
  );
  return (
    [...new Set([...summary, ...errors])].join('\n') ||
    (errors.length ? errors.join('\n') : 'Install completed.')
  );
}
function filesystemCandidate(input: string, cap = 100): string {
  const rows = genericFilter(input, { maxLines: 10000 }).split('\n').filter(Boolean);
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (
      /^\s*(directory of |directory:|mode\s+lastwritetime\s+length\s+name|volume in drive)/i.test(
        row,
      )
    )
      continue;
    const key = /<DIR>|^d[-rwx]+\s/i.test(row)
      ? 'Directories'
      : /\.[^\\/\s]+(?:\s|$)/.test(row)
        ? 'Files'
        : 'Entries';
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  let count = 0;
  const output = [...groups].map(([name, entries]) => {
    const remaining = Math.max(0, cap - count);
    const kept = entries.slice(0, remaining);
    count += kept.length;
    return `${name} (${String(entries.length)}):\n${kept.map((row) => `  ${row}`).join('\n')}${kept.length < entries.length ? `\n  ... ${String(entries.length - kept.length)} entries elided ...` : ''}`;
  });
  return output.join('\n');
}

export const filterGitStatus = (input: string): string =>
  keepOnlyIfSmaller(input, gitStatusCandidate(input));
export const filterGitDiff = (input: string, context = 1): string =>
  keepOnlyIfSmaller(input, gitDiffCandidate(input, context));
export const filterGitLog = (input: string): string =>
  keepOnlyIfSmaller(input, gitLogCandidate(input));
export const filterTestOutput = (input: string): string =>
  keepOnlyIfSmaller(input, testCandidate(input));
export const filterBuildOutput = (input: string): string =>
  keepOnlyIfSmaller(input, buildCandidate(input));
export const filterPackageInstall = (input: string): string =>
  keepOnlyIfSmaller(input, packageInstallCandidate(input));
export const filterFilesystem = (input: string, cap = 100): string =>
  keepOnlyIfSmaller(input, filesystemCandidate(input, cap));
