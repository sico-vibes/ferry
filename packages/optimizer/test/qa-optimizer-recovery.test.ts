import { describe, expect, it } from 'vitest';
import { estimateTokens, filterTestOutput, filterToolOutput } from '../src/index.js';
import { InMemoryBlobStore, readOutput } from '../src/recovery.js';

describe('QA optimizer recovery: byte-exact round trips', () => {
  const cases: { name: string; value: string }[] = [
    { name: 'CRLF text', value: 'alpha\r\nbeta\r\ngamma\r\n' },
    { name: 'CR-only text', value: 'a\rb\rc\r' },
    { name: 'no trailing newline', value: 'one\ntwo\nthree' },
    { name: 'UTF-16LE-looking text with NULs', value: '\u0000h\u0000i\u0000\r\u0000\n' },
    { name: 'lone surrogates and NUL', value: `\u0000\uD800\uDC00\uFFFD${String.fromCharCode(0)}` },
    { name: 'empty', value: '' },
    {
      name: 'huge varied payload',
      value: Array.from({ length: 200_000 }, (_, i) => i % 251).join(''),
    },
  ];
  for (const { name, value } of cases) {
    it(`returns the exact original for ${name}`, () => {
      const store = new InMemoryBlobStore();
      const result = filterToolOutput('cat payload.bin', value, {
        blobStore: store,
        sessionId: 's',
      });
      if (result.output !== value) {
        expect(result.handle).toBeDefined();
        expect(readOutput(store, result.handle ?? '')).toBe(value);
      } else {
        expect(result.handle).toBeUndefined();
        expect(result.output).toBe(value);
      }
    });
  }

  it('returns the exact line range and grep matches without mangling endings', () => {
    const store = new InMemoryBlobStore();
    const value = 'one\r\ntwo\r\nthree\r\nfour\r\n';
    const handle = store.put('s', value);
    expect(readOutput(store, handle, { startLine: 2, endLine: 3 })).toBe('two\r\nthree\r\n');
    expect(readOutput(store, handle, { grep: 'three' })).toBe('three\r\n');
    expect(readOutput(store, handle, { startLine: 2, endLine: 2, grep: 'four' })).toBe('');
  });

  it('never reports negative savings through the tool-output filter', () => {
    const samples = [
      'a\n'.repeat(5000),
      Array.from({ length: 300 }, (_, i) => `line ${String(i)}`).join('\n'),
      JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ i })) }),
    ];
    for (const sample of samples) {
      const result = filterToolOutput('git diff', sample, { blobStore: new InMemoryBlobStore() });
      expect(result.event.afterTokens).toBeLessThanOrEqual(result.event.beforeTokens);
    }
  });
});

describe('QA optimizer recovery: error visibility', () => {
  it.fails('does not claim all tests passed when the output contains an error line', () => {
    // BUG: testCandidate()'s pass heuristic matches "Tests  N passed (N)" and
    // ignores failure markers it does not recognize (npm ERR!, "exit code 1"),
    // so a failed run is rewritten to "All tests passed." (filters.ts:285-300).
    const output = 'Tests  3 passed (3)\nnpm ERR! code ELIFECYCLE\n';
    expect(filterTestOutput(output)).not.toBe('All tests passed.');
  });

  it.fails('does not claim all tests passed when a bare exit code follows a pass line', () => {
    // BUG: same heuristic — "3 passed in 0.4s" plus "exit code 1" is reported
    // as a complete success, hiding the non-zero exit status (filters.ts:286).
    const output = '  3 passed in 0.4s\nProcess completed with exit code 1\n';
    expect(filterTestOutput(output)).not.toBe('All tests passed.');
  });
});

describe('QA optimizer recovery: pathological inputs', () => {
  it.fails(
    'estimates tokens for a large repeated-character payload in bounded time',
    () => {
      // BUG: @ferry/shared/tokens estimateTokens() (gpt-tokenizer) is super-linear
      // for long runs of a single character: 100k identical chars takes multiple
      // seconds. optimizeOutput calls it 4-6 times per filter, synchronously, so a
      // large tool output blocks the agent loop and cannot be cancelled.
      const input = 'x'.repeat(100_000);
      const started = Date.now();
      estimateTokens(input);
      expect(Date.now() - started).toBeLessThan(500);
    },
    30_000,
  );
});
