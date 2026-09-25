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
  it('does not claim all tests passed when the output contains an error line', () => {
    // Error lines must prevent a success summary and remain visible.
    const output = 'Tests  3 passed (3)\nnpm ERR! code ELIFECYCLE\n';
    expect(filterTestOutput(output)).not.toBe('All tests passed.');
  });

  it('does not claim all tests passed when a bare exit code follows a pass line', () => {
    // A non-zero exit status takes precedence over a pass summary.
    const output = '  3 passed in 0.4s\nProcess completed with exit code 1\n';
    expect(filterTestOutput(output)).not.toBe('All tests passed.');
  });
});

describe('QA optimizer recovery: pathological inputs', () => {
  it('estimates tokens for a large repeated-character payload in bounded time', () => {
    // Large repeated payloads should use the bounded estimator path.
    const input = 'x'.repeat(2_000_000);
    const started = Date.now();
    estimateTokens(input);
    expect(Date.now() - started).toBeLessThan(500);
  }, 30_000);

  it('preserves other failure markers and structured non-zero runner exit codes', () => {
    for (const marker of ['FAIL suite.test.ts', 'Error: test setup failed', 'ELIFECYCLE']) {
      const filtered = filterTestOutput(`Tests  3 passed (3)\n${marker}\n`);
      expect(filtered).not.toBe('All tests passed.');
      expect(filtered).toContain(marker);
    }
    expect(
      filterTestOutput('{"exitCode":1,"stdout":"Tests 3 passed (3)\\n","stderr":""}'),
    ).not.toBe('All tests passed.');
  });
});
