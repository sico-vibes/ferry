import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  estimateTokens,
  filterToolOutput,
  InMemoryBlobStore,
  optimizeContextMessages,
  readOutput,
  TERSE_LEVEL_TEXT,
} from '../packages/optimizer/src/index.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(root, 'packages', 'optimizer', 'test', 'fixtures', 'large');
const fixture = async (name) => readFile(join(fixtureRoot, name), 'utf8');
const generatedLog =
  Array.from(
    { length: 5000 },
    (_, index) => `worker ${index % 7} INFO processing line ${index + 1}`,
  ).join('\n') + '\nFATAL-TAIL: worker failed at src/final-target.ts:5000';
const jsonPayload = JSON.stringify({
  records: Array.from({ length: 2500 }, (_, index) => ({
    id: index,
    path: `src/generated-${index}.ts`,
    html: `<section data-id="${index}">${'payload '.repeat(14)}</section>`,
  })),
});
const htmlPayload = `<!doctype html><html><head><script>${'const noise = 1;'.repeat(3000)}</script></head><body>${Array.from(
  { length: 120 },
  (_, index) => `<p>Diagnostic ${index}</p>`,
).join('\n')}<p>ERROR: page failed</p></body></html>`;
const jestFailure = [
  'FAIL src/math.test.ts',
  '  ● math > preserves the result',
  '    expect(received).toBe(expected)',
  '    Expected: 42',
  '    Received: 41',
  '      at Object.<anonymous> (src/math.test.ts:18:11)',
  'Test Suites: 1 failed, 1 total',
  'Tests:       1 failed, 14 passed, 15 total',
  'Snapshots:   0 total',
  'Time:        1.42 s',
].join('\n');
const goFailure = [
  '--- FAIL: TestTaxRounding (0.00s)',
  '    invoice_test.go:24: CalculateTax(1, 0.2) = 0.19, want 0.20',
  'FAIL example.com/ferry/billing 0.014s',
].join('\n');
const cargoFailure = [
  'running 3 tests',
  'test test_auth_expiry ... FAILED',
  '',
  'failures:',
  '',
  '---- test_auth_expiry stdout ----',
  "thread 'test_auth_expiry' panicked at 'expected 401, got 200', src/auth.rs:117:9",
  '',
  'failures:',
  '    test_auth_expiry',
  '',
  'test result: FAILED. 2 passed; 1 failed; 0 ignored; finished in 0.02s',
].join('\n');

const cases = [
  {
    command: 'pnpm vitest run',
    text: await fixture('vitest-214-pass-2-fail.txt'),
    must: [
      'FAIL',
      'AssertionError',
      'src/auth/session.test.ts:117:9',
      'Tests  2 failed | 212 passed',
    ],
  },
  {
    command: 'npx jest',
    text: await fixture('jest-500-pass.txt'),
    must: ['Test Suites:', 'Tests:', 'Snapshots:', 'Time:'],
  },
  {
    command: 'npx jest --runInBand',
    text: jestFailure,
    must: ['FAIL src/math.test.ts', 'Expected: 42', 'Received: 41', 'src/math.test.ts:18:11'],
  },
  {
    command: 'pytest -q',
    text: await fixture('pytest-tracebacks.txt'),
    must: [
      'FAILURES',
      'Traceback',
      'tests/auth/test_session.py',
      'assert response.status_code == 401',
      '2 failed, 146 passed, 3 skipped',
    ],
  },
  {
    command: 'go test ./...',
    text: goFailure,
    must: [
      '--- FAIL: TestTaxRounding',
      'invoice_test.go:24',
      'want 0.20',
      'FAIL example.com/ferry/billing',
    ],
  },
  {
    command: 'cargo test',
    text: cargoFailure,
    must: [
      'test result: FAILED',
      'test_auth_expiry stdout',
      'expected 401, got 200',
      'src/auth.rs:117:9',
    ],
  },
  {
    command: 'pnpm exec tsc --noEmit',
    text: await fixture('tsc-40-errors-9-files.txt'),
    must: ['src/modules/module-1.ts(10,3)', 'error TS2322', 'Result<2>'],
  },
  {
    command: 'pnpm exec eslint .',
    text: await fixture('eslint-120-warnings.txt'),
    must: ['src/components/Component-0.tsx:1:7: warning:', 'no-explicit-any'],
  },
  {
    command: 'git status --short',
    text: await fixture('git-status-60-files.txt'),
    must: ['feature/b7', 'src/'],
  },
  {
    command: 'git diff',
    text: await fixture('git-diff-800-lines-12-files.txt'),
    must: ['diff --git', 'src/'],
  },
  { command: 'git log --oneline', text: await fixture('git-log-200.txt'), must: ['5000001'] },
  {
    command: 'pnpm install',
    text: await fixture('pnpm-install.txt'),
    must: ['resolved'],
  },
  {
    command: 'node emit-log.mjs',
    text: generatedLog,
    must: ['FATAL-TAIL', 'src/final-target.ts:5000'],
  },
  {
    command: 'read_file src/large.ts',
    text: 'export const large = 1;\n'.repeat(3000),
    must: ['export const large'],
  },
];

const totals = new Map();
const assertContains = (name, output, markers) => {
  for (const marker of markers)
    if (!output.includes(marker))
      throw new Error(`${name}: filtered output lost required marker ${marker}`);
};
for (const item of cases) {
  const store = new InMemoryBlobStore();
  const result = filterToolOutput(item.command, item.text, {
    blobStore: store,
    sessionId: 'bench',
  });
  assertContains(item.command, result.output, item.must);
  const group = totals.get(result.event.kind) ?? { before: 0, after: 0, samples: 0 };
  group.before += result.event.beforeTokens;
  group.after += result.event.afterTokens;
  group.samples += 1;
  totals.set(result.event.kind, group);
}

for (const [name, text, kind, path] of [
  ['large-json', jsonPayload, 'json', undefined],
  ['large-html', htmlPayload, 'html', undefined],
  [
    'repeated-file-read',
    'export const stableValue = 42;\n'.repeat(1200),
    'file-read',
    'src/stable.ts',
  ],
  ['stale-tool-result', generatedLog, 'tool-result', undefined],
]) {
  const store = new InMemoryBlobStore();
  const before = [
    { role: 'tool', content: text, kind, ...(path ? { path } : {}), step: 1 },
    ...(name === 'repeated-file-read'
      ? [{ role: 'tool', content: text, kind, path, step: 2 }]
      : []),
  ];
  const result = optimizeContextMessages(before, {
    currentStep: 8,
    staleAfterSteps: 5,
    blobStore: store,
    sessionId: 'bench',
    maxPayloadTokens: 900,
  });
  if (name === 'large-json')
    assertContains(name, JSON.stringify(result.output), ['src/generated-0.ts', 'items omitted']);
  if (name === 'large-html')
    assertContains(name, JSON.stringify(result.output), ['ERROR: page failed']);
  if (name === 'repeated-file-read')
    assertContains(name, JSON.stringify(result.output), ['src/stable.ts unchanged']);
  if (name === 'stale-tool-result')
    assertContains(name, JSON.stringify(result.output), ['Older tool result', 'recover']);
  const group = totals.get('context-hygiene') ?? { before: 0, after: 0, samples: 0 };
  group.before += result.event.beforeTokens;
  group.after += result.event.afterTokens;
  group.samples += 1;
  totals.set('context-hygiene', group);
}

const recoveryStore = new InMemoryBlobStore();
const recoverable = filterToolOutput('node emit-log.mjs', generatedLog, {
  blobStore: recoveryStore,
  sessionId: 'bench',
});
const recoveryTokens = estimateTokens(readOutput(recoveryStore, recoverable.handle) ?? '');
totals.set('recovery-read', { before: 0, after: recoveryTokens, samples: 1 });

const tersePromptBefore = estimateTokens(TERSE_LEVEL_TEXT.Off);
for (const level of ['Lite', 'Full', 'Ultra']) {
  const group = totals.get('terse-prompt') ?? { before: 0, after: 0, samples: 0 };
  group.before += tersePromptBefore;
  group.after += estimateTokens(TERSE_LEVEL_TEXT[level]);
  group.samples += 1;
  totals.set('terse-prompt', group);
}
const responseTokens = estimateTokens(
  'The build failed because src/index.ts has a type mismatch. Change the value to a number, then rerun the build.',
);
totals.set('terse-response', { before: responseTokens, after: responseTokens, samples: 1 });

const rows = [...totals].map(([kind, value]) => ({
  kind,
  samples: value.samples,
  beforeTokens: value.before,
  afterTokens: value.after,
  savedTokens: value.before - value.after,
}));
const beforeTokens = rows.reduce((sum, row) => sum + row.beforeTokens, 0);
const afterTokens = rows.reduce((sum, row) => sum + row.afterTokens, 0);
console.log('Optimizer replay benchmark (shared tokenizer; deterministic corpus)');
console.log('| Optimizer | Samples | Before | After | Net saved |');
console.log('|---|---:|---:|---:|---:|');
for (const row of rows)
  console.log(
    `| ${row.kind} | ${row.samples} | ${row.beforeTokens} | ${row.afterTokens} | ${row.savedTokens} |`,
  );
console.log(
  `| Total | ${rows.reduce((sum, row) => sum + row.samples, 0)} | ${beforeTokens} | ${afterTokens} | ${beforeTokens - afterTokens} |`,
);
console.log('Correctness: all required errors, failure markers, and paths survived filtering.');
