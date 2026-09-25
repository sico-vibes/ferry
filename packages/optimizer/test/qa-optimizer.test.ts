import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
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
  detectOutputKind,
} from '../src/filters.js';
import { compressJsonPayload, hygieneMessages } from '../src/hygiene.js';
import { estimateTokens, keepOnlyIfSmaller, runOptimizer } from '../src/measurement.js';
import { InMemoryBlobStore, readOutput } from '../src/recovery.js';

const allFilters: ((input: string) => string)[] = [
  genericFilter,
  filterGitStatus,
  filterGitDiff,
  filterGitLog,
  filterTestOutput,
  filterBuildOutput,
  filterPackageInstall,
  filterFilesystem,
  (input) => filterToolOutput('pnpm test', input).output,
  (input) => filterToolOutput('git diff', input).output,
  (input) => filterToolOutput('Get-ChildItem -Recurse', input).output,
  compressJsonPayload,
];

describe('QA optimizer: never inflate', () => {
  it('never grows a filtered result and returns the exact input when it cannot shrink', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8_000 }), (input) => {
        const before = estimateTokens(input);
        for (const filter of allFilters) {
          const output = filter(input);
          const after = estimateTokens(output);
          expect(after).toBeLessThanOrEqual(before);
          if (after >= before) expect(output).toBe(input);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('never inflates through the measured wrappers', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2_000 }), (input) => {
        const result = runOptimizer(input, 'generic', () => `${input}${input}`);
        expect(result.event.afterTokens).toBeLessThanOrEqual(result.event.beforeTokens);
        expect(result.output).toBe(input);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps content for families whose output does not match a known format', () => {
    const sample = 'plain text\nnot a diff';
    expect(filterGitStatus(sample)).toContain('plain text');
    expect(filterToolOutput('git status', sample).output).toContain('plain text');
  });

  it.fails('keeps the first line of an unrecognized git log message', () => {
    // BUG: gitLogCandidate() treats the first free line as a commit subject and
    // never emits it, so a single-line git error such as a fatal message is
    // erased from the filtered output entirely.
    const filtered = filterToolOutput('git log', 'fatal: bad revision HEAD~999\n');
    expect(filtered.output).toContain('fatal');
  });

  it.fails('keeps a binary git diff notice instead of erasing it', () => {
    // BUG: gitDiffCandidate() drops every line that is not a header, hunk, or
    // stat line, so "Binary files ... differ" disappears from the filtered diff.
    const output = 'diff --git a/x b/x\nindex 111..222 100644\nBinary files a/x and b/x differ\n';
    const filtered = filterToolOutput('git diff', output);
    expect(filtered.output).toContain('Binary files');
  });

  it.fails('does not replace unrecognized test output with an all-pass claim', () => {
    // BUG: the "All tests passed" heuristic only recognizes "✗"/"×" failure
    // markers, so a runner that prints "✕" plus an "N passed in Xs" summary is
    // silently rewritten to "All tests passed.", hiding the failures.
    const output = '  ✕ rejects bad input\n  3 passed in 0.4s\n';
    expect(filterTestOutput(output)).not.toBe('All tests passed.');
  });

  it.fails('does not claim success for a failed install it cannot parse', () => {
    // BUG: packageInstallCandidate() falls back to "Install completed." whenever
    // no line matches its error heuristics, so an unparsed failure is reported as
    // success.
    expect(filterPackageInstall('zsh: killed     pnpm install\n')).not.toBe('Install completed.');
  });
});

describe('QA optimizer: byte-exact recovery', () => {
  const originals = [
    'first\nsecond\nthird\n',
    '\ufeffa\r\nb\r\nc',
    'no trailing newline',
    'a\rb\rc\n',
    `${'repeated line\n'.repeat(500)}tail`,
  ];
  for (const original of originals) {
    it(`recovers ${JSON.stringify(original.slice(0, 12))}… exactly`, () => {
      const store = new InMemoryBlobStore();
      const filtered = filterToolOutput('cat output.txt', original, {
        blobStore: store,
        sessionId: 's',
      });
      if (filtered.handle === undefined) {
        expect(filtered.output).toBe(original);
        return;
      }
      expect(readOutput(store, filtered.handle)).toBe(original);
    });
  }

  it('recovers exact line ranges and string greps', () => {
    const store = new InMemoryBlobStore();
    const original = 'one\ntwo\nthree\nfour\n';
    const handle = store.put('s', original);
    expect(readOutput(store, handle, { startLine: 2, endLine: 3 })).toBe('two\nthree\n');
    expect(readOutput(store, handle, { grep: 'three' })).toBe('three\n');
  });

  it.fails('applies a RegExp grep without leaking stateful lastIndex across lines', () => {
    // BUG: readOutput() calls RegExp.test() directly; a caller-supplied global
    // regex advances lastIndex between lines, so alternating lines are dropped.
    const store = new InMemoryBlobStore();
    const handle = store.put('s', 'foo\nfoo\nfoo\n');
    expect(readOutput(store, handle, { grep: /foo/g })).toBe('foo\nfoo\nfoo\n');
  });
});

describe('QA optimizer: unexpected inputs', () => {
  it('clamps line counts without negative duplication', () => {
    const input = Array.from({ length: 1_000 }, (_, index) => `line ${String(index)}`).join('\n');
    const store = new InMemoryBlobStore();
    const filtered = filterToolOutput('ls -la', input, { maxLines: 1, blobStore: store });
    expect(filtered.event.afterTokens).toBeLessThanOrEqual(filtered.event.beforeTokens);
    expect(filtered.output).not.toContain('undefined');
  });

  it('compresses JSON arrays while preserving recovery of the original', () => {
    const payload = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ i })) });
    const store = new InMemoryBlobStore();
    const compressed = compressJsonPayload(payload, 2);
    expect(estimateTokens(compressed)).toBeLessThanOrEqual(estimateTokens(payload));
    const handle = store.put('s', payload);
    expect(readOutput(store, handle)).toBe(payload);
  });

  it('detects command families and defaults unknown commands to generic', () => {
    expect(detectOutputKind('git status --short')).toBe('git-status');
    expect(detectOutputKind('git diff --stat')).toBe('git-diff');
    expect(detectOutputKind('pnpm test')).toBe('test');
    expect(detectOutputKind('tsc --noEmit')).toBe('build');
    expect(detectOutputKind('Get-ChildItem -Recurse')).toBe('filesystem');
    expect(detectOutputKind('frobnicate everything')).toBe('generic');
  });

  it('keeps hygiene output no larger than the original context', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4_000 }), (content) => {
        const messages = [
          { role: 'tool', kind: 'tool-result', step: 1, content },
          { role: 'tool', kind: 'json', step: 2, content },
        ];
        const before = estimateTokens(JSON.stringify(messages));
        const result = hygieneMessages(messages, {
          currentStep: 10,
          staleAfterSteps: 1,
          blobStore: new InMemoryBlobStore(),
        });
        const after = estimateTokens(JSON.stringify(result));
        if (after > before) {
          expect(result).toEqual(messages);
        } else {
          expect(after).toBeLessThanOrEqual(before);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('keepOnlyIfSmaller is a strict no-op on ties', () => {
    expect(keepOnlyIfSmaller('abc', 'abcd')).toBe('abc');
    expect(keepOnlyIfSmaller('abc', 'abc')).toBe('abc');
    expect(keepOnlyIfSmaller('a very long line', 'x')).toBe('x');
  });
});
