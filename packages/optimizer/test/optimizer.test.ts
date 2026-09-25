import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  filterBuildOutput,
  filterFilesystem,
  filterGitDiff,
  filterGitLog,
  filterGitStatus,
  filterPackageInstall,
  filterTestOutput,
  filterToolOutput,
  genericFilter,
} from '../src/filters.js';
import { compressJsonPayload, hygieneMessages, optimizeContextMessages } from '../src/hygiene.js';
import { estimateTokens, rollupByDay, runOptimizer } from '../src/measurement.js';
import { InMemoryBlobStore, readOutput } from '../src/recovery.js';
import { rewriteWithRtk, rtkAvailable } from '../src/rtk.js';
import { terseSystemText } from '../src/terse.js';
import { estimateTokens as canonicalEstimateTokens } from '@ferry/shared/tokens';

const largeFixtures = [
  ['vitest run', 'vitest-214-pass-2-fail.txt'],
  ['npx jest', 'jest-500-pass.txt'],
  ['pytest -q', 'pytest-tracebacks.txt'],
  ['git diff', 'git-diff-800-lines-12-files.txt'],
  ['git status', 'git-status-60-files.txt'],
  ['git log', 'git-log-200.txt'],
  ['tsc --noEmit', 'tsc-40-errors-9-files.txt'],
  ['eslint .', 'eslint-120-warnings.txt'],
  ['pnpm install', 'pnpm-install.txt'],
  ['Get-ChildItem -Recurse', 'get-childitem-1500.txt'],
  ['dir /s', 'dir-s-1500.txt'],
] as const;
const largeFixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'large', name), 'utf8');

describe('golden tool-output fixtures', () => {
  const fixtures = [
    [
      'git status --short',
      '## feature/b7...origin/feature/b7\n M packages/optimizer/src/index.ts\n M packages/optimizer/src/index.ts\n?? notes.txt\n',
      '## feature/b7...origin/feature/b7\n M packages/optimizer/src/index.ts\n M packages/optimizer/src/index.ts\n?? notes.txt\n',
    ],
    [
      'git diff',
      'diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,5 +1,5 @@\n context one\n context two\n-old value\n+new value\n context three\n context four\n context five\n',
      'diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,5 +1,5 @@\n context two\n-old value\n+new value\n context three',
    ],
    [
      'pnpm test',
      ' RUN  v3.2.0 C:/repo\n ✓ src/a.test.ts (4 tests)\n ❯ src/b.test.ts (3 tests | 1 failed)\n   × rejects bad input\n     AssertionError: expected 2 to be 3\nTest Files  1 failed | 1 passed (2)\nTests  1 failed | 6 passed (7)\n',
      '❯ src/b.test.ts (3 tests | 1 failed)\n   × rejects bad input\n     AssertionError: expected 2 to be 3\nTest Files  1 failed | 1 passed (2)\nTests  1 failed | 6 passed (7)',
    ],
    [
      'npx vitest run',
      ' RUN  v3.2.0 C:/repo\n ✓ src/a.test.ts (4 tests)\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n',
      'All tests passed.',
    ],
    [
      'Get-ChildItem -Recurse',
      ' Directory: C:\\work\\src\n\nMode LastWriteTime Length Name\nd---- 2026-09-01 0 lib\n-a--- 2026-09-01 12 a.ts\n-a--- 2026-09-01 14 b.ts\n',
      'Directories (1):\n  d---- 2026-09-01 0 lib\nFiles (2):\n  -a--- 2026-09-01 12 a.ts\n  -a--- 2026-09-01 14 b.ts',
    ],
    [
      'dir',
      ' Volume in drive C is OS\n Directory of C:\\work\n\n09/01/2026  10:00 AM    <DIR>          src\n09/01/2026  10:01 AM               42 app.ts\n',
      'Directories (1):\n  09/01/2026  10:00 AM    <DIR>          src\nFiles (1):\n  09/01/2026  10:01 AM               42 app.ts',
    ],
    [
      'pytest -q',
      '...F.                                                                    [100%]\n=================================== FAILURES ===================================\n________________ test_bad __________________\nE   AssertionError: 1 != 2\n=========================== short test summary info ===========================\n1 failed, 4 passed in 0.03s\n',
      '...F.                                                                    [100%]\n________________ test_bad __________________\nE   AssertionError: 1 != 2\n1 failed, 4 passed in 0.03s',
    ],
  ] as const;
  for (const [command, input, expected] of fixtures)
    it(`filters ${command}`, () => {
      expect(filterToolOutput(command, input).output).toBe(expected);
    });
});

describe('measurement, recovery, and helpers', () => {
  it('reports estimates, supports benchmark bypass, and rolls up by day', () => {
    const result = runOptimizer('before before before', 'generic', () => 'after', {
      benchmarkMode: true,
    });
    expect(result.output).toBe('before before before');
    expect(result.event.beforeTokens).toBe(estimateTokens('before before before'));
    expect(result.event.afterTokens).toBe(result.event.beforeTokens);
    const expanded = runOptimizer('x', 'generic', () => 'a much longer candidate output');
    expect(expanded.output).toBe('x');
    expect(expanded.event.afterTokens).toBe(expanded.event.beforeTokens);
    expect(
      rollupByDay([{ ...result.event, timestamp: '2026-09-24T09:00:00Z' }]).get('2026-09-24')
        ?.events,
    ).toBe(1);
    expect(estimateTokens('12345')).toBe(canonicalEstimateTokens('12345'));
  });
  it('recovers the byte-exact original and exact line slices', () => {
    const original = '\ufefffirst\r\n' + 'long repeated line payload\r\n'.repeat(20) + 'third  \n';
    const store = new InMemoryBlobStore();
    const filtered = filterToolOutput('cat output.txt', original, {
      blobStore: store,
      sessionId: 's',
    });
    expect(filtered.handle).toBeDefined();
    const handle = filtered.handle;
    if (handle === undefined) throw new Error('Expected a recovery handle');
    expect(readOutput(store, handle, { startLine: 2, endLine: 2 })).toBe(
      'long repeated line payload\r\n',
    );
    expect(store.get(handle)).toBe(original);
  });
  it('expires blobs on TTL and supports grep recovery', () => {
    let now = 0;
    const store = new InMemoryBlobStore(10, () => now);
    const handle = store.put('s', 'one\ntwo\n');
    expect(readOutput(store, handle, { grep: 'two' })).toBe('two\n');
    now = 11;
    expect(store.get(handle)).toBeUndefined();
  });
  it('stubs repeated file reads and summarizes stale tool results', () => {
    const store = new InMemoryBlobStore();
    const messages = hygieneMessages(
      [
        {
          role: 'tool',
          path: 'src/app.ts',
          kind: 'file-read',
          step: 1,
          content: 'The file contents are lengthy and unchanged since their previous read. '.repeat(
            8,
          ),
        },
        {
          role: 'tool',
          path: 'src/app.ts',
          kind: 'file-read',
          step: 2,
          content: 'The file contents are lengthy and unchanged since their previous read. '.repeat(
            8,
          ),
        },
        {
          role: 'tool',
          kind: 'tool-result',
          step: 1,
          content: 'line one with a detailed result that does not need to be repeated\n'.repeat(40),
        },
      ],
      { currentStep: 10, blobStore: store, staleAfterSteps: 4 },
    );
    expect(messages[1]?.content).toContain('unchanged since step 1');
    expect(messages[2]?.content).toContain('Older tool result');
    expect(messages[2]?.handle).toBeDefined();
  });
  it('detects RTK locations and rewrites supported commands only', () => {
    expect(rtkAvailable('C:\\tools;C:\\bin', (candidate) => candidate === 'C:\\bin\\rtk.exe')).toBe(
      true,
    );
    expect(rewriteWithRtk('pnpm test', true)).toBe('rtk pnpm test');
    expect(rewriteWithRtk('echo pnpm test', true)).toBe('echo pnpm test');
  });
  it('exports terse levels and hard rules', () => {
    expect(terseSystemText('Ultra')).toContain('Never compress code');
    expect(terseSystemText('Off')).toBe('Use normal concise prose.');
  });
  it('collapses progress and duplicate lines', () => {
    expect(genericFilter('\u001b[32mok\u001b[0m\rprogress 1\rprogress 2\nrepeat\nrepeat\n')).toBe(
      'progress 2\nrepeat (repeated 2 times)\n',
    );
  });
});

describe('never-inflate properties', () => {
  it('returns the exact original whenever any filter cannot save tokens', () => {
    const filters: ((input: string) => string)[] = [
      genericFilter,
      filterGitStatus,
      filterGitDiff,
      filterGitLog,
      filterTestOutput,
      filterBuildOutput,
      filterPackageInstall,
      filterFilesystem,
      (input) => filterToolOutput('pnpm test', input).output,
      compressJsonPayload,
    ];
    fc.assert(
      fc.property(fc.string(), (input) => {
        const before = estimateTokens(input);
        for (const filter of filters) {
          const output = filter(input);
          const after = estimateTokens(output);
          expect(after).toBeLessThanOrEqual(before);
          if (after >= before) expect(output).toBe(input);
        }
        const messages = [{ role: 'tool', kind: 'tool-result', step: 1, content: input }];
        const context = optimizeContextMessages(messages, {
          currentStep: 10,
          staleAfterSteps: 1,
          blobStore: new InMemoryBlobStore(),
        });
        const beforeContext = estimateTokens(JSON.stringify(messages));
        expect(context.event.afterTokens).toBeLessThanOrEqual(beforeContext);
        if (context.event.afterTokens >= beforeContext) expect(context.output).toEqual(messages);
      }),
      { numRuns: 150 },
    );
  });
});

describe('large realistic golden fixtures', () => {
  for (const [command, file] of largeFixtures) {
    it(`never inflates ${file}`, () => {
      const input = largeFixture(file);
      const result = filterToolOutput(command, input, { maxLines: 120 });
      expect(result.event.beforeTokens).toBe(estimateTokens(input));
      expect(result.event.afterTokens).toBeLessThanOrEqual(result.event.beforeTokens);
      if (result.event.afterTokens >= result.event.beforeTokens) expect(result.output).toBe(input);
      if (file === 'jest-500-pass.txt') expect(result.output).toBe('All tests passed.');
      if (file === 'git-diff-800-lines-12-files.txt') {
        expect(result.output).toContain('diff --stat');
        expect(result.output).toContain('12 files changed');
      }
    });
  }
});
