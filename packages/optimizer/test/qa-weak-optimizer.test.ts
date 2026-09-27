/* eslint
  @typescript-eslint/no-non-null-assertion: off,
  @typescript-eslint/require-await: off
*/
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { compactContext } from '../src/compaction.js';
import { InMemoryBlobStore, readOutput } from '../src/recovery.js';

const estimate = (text: string): number => text.length;

describe('QA weak optimizer: compaction keeps the conversation spine', () => {
  it('never drops non-tool messages or the latest user message', () => {
    const messages = [
      { role: 'tool', toolOutput: true, content: 'x'.repeat(4000), recoveryHandle: 'H' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'tool', toolOutput: true, content: 'y'.repeat(4000), recoveryHandle: 'G' },
      { role: 'user', content: 'the latest question' },
    ];
    const result = compactContext(messages, 50, estimate, {
      protectedTail: 1,
      maxToolBytes: 100_000,
    });
    expect(result.messages).toHaveLength(5);
    expect(result.messages[1]).toEqual(messages[1]);
    expect(result.messages[2]).toEqual(messages[2]);
    expect(result.messages[4]).toEqual(messages[4]);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
  });

  it('prunes only unprotected tool outputs', () => {
    const messages = [
      { role: 'tool', toolOutput: true, content: 'x'.repeat(5000), recoveryHandle: 'A' },
      { role: 'tool', toolOutput: true, content: 'y'.repeat(5000), recoveryHandle: 'B' },
      { role: 'tool', toolOutput: true, content: 'z'.repeat(5000), recoveryHandle: 'C' },
    ];
    const result = compactContext(messages, 10, estimate, {
      protectedTail: 1,
      maxToolBytes: 100_000,
    });
    expect(result.messages[0]?.content).toContain('older tool output pruned');
    expect(result.messages[1]?.content).toContain('older tool output pruned');
    expect(result.messages[2]?.content).toBe('z'.repeat(5000));
  });

  it('leaves unresolved tool results without output text untouched', () => {
    const result = compactContext(
      [
        { role: 'assistant', toolOutput: true },
        { role: 'tool', toolOutput: true, content: 'x'.repeat(5000) },
      ],
      1,
      estimate,
      { protectedTail: 0, maxToolBytes: 100_000 },
    );
    expect(result.messages[0]).toEqual({ role: 'assistant', toolOutput: true });
  });
});

describe('QA weak optimizer: recovery stays byte-exact after compaction', () => {
  it('keeps the handle and returns the exact original after an output is pruned', () => {
    const store = new InMemoryBlobStore();
    const original = 'line1\r\nline2\r\nline3\r\n';
    const handle = store.put('s', original);
    const result = compactContext(
      [{ role: 'tool', toolOutput: true, content: original, recoveryHandle: handle }],
      1,
      estimate,
      { protectedTail: 0, maxToolBytes: 100_000 },
    );
    expect(result.messages[0]?.content).toContain('older tool output pruned');
    expect(result.messages[0]?.recoveryHandle).toBe(handle);
    expect(readOutput(store, handle)).toBe(original);
  });

  it('does not split a multi-byte code point when truncating', () => {
    const content = 'a'.repeat(9) + '🎉' + 'b'.repeat(10);
    const result = compactContext(
      [{ role: 'tool', toolOutput: true, content, recoveryHandle: 'M' }],
      1e9,
      estimate,
      { maxToolBytes: 10 },
    );
    expect(result.messages[0]?.content ?? '').not.toContain('\uFFFD');
    expect(result.messages[0]?.content ?? '').toContain('output truncated');
  });

  it('round-trips random payloads that contain no line/paragraph separators', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom('a', 'b', '\n', '\r', '\r\n', '\t', '🎉', ' '), {
            maxLength: 60,
          })
          .map((parts) => parts.join('')),
        (value) => {
          const store = new InMemoryBlobStore();
          const handle = store.put('s', value);
          expect(readOutput(store, handle)).toBe(value);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns the byte-exact original for content containing U+2028/U+2029', () => {
    // BUG: readOutput splits with /.*(?:\r\n|\n|\r|$)/g, and JavaScript "." does
    // not match U+2028/U+2029. Any line/paragraph separator makes match() bail out
    // of the whole string, so the recovered output silently loses content.
    const store = new InMemoryBlobStore();
    for (const value of ['a\u2028b', 'a\u2029b', 'head\n\u2028tail']) {
      const handle = store.put('s', value);
      expect(readOutput(store, handle)).toBe(value);
    }
  });
});
