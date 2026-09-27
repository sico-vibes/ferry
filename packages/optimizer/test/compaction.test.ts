import { describe, expect, it } from 'vitest';
import { compactContext } from '../src/compaction.js';
describe('tiered context compaction', () => {
  it('hard-caps tool output while retaining a recovery path', () => {
    const [message] = compactContext(
      [{ role: 'tool', toolOutput: true, content: 'x'.repeat(12_000), recoveryHandle: 'blob-1' }],
      10_000,
      (text) => text.length,
      { maxToolBytes: 10_000 },
    ).messages;
    expect(message?.content).toContain('output truncated');
    expect(message?.content.length).toBeLessThan(10_100);
  });

  it('prunes old outputs over threshold while protecting the tail', () => {
    const messages = [
      { role: 'tool', toolOutput: true, content: 'x'.repeat(12000) },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ];
    const result = compactContext(messages, 10, (text) => text.length, {
      protectedTail: 2,
      maxToolBytes: 10000,
    });
    expect(result.messages[0]?.content).toContain('older tool output pruned');
    expect(result.pruned).toBe(1);
    expect(result.summary).toContain('1 older tool');
  });
});
