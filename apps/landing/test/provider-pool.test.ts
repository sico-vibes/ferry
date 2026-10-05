import { describe, expect, it } from 'vitest';
import {
  SLOT_COUNT,
  providerMarks,
  providerSlotQueues,
  shuffleProviders,
} from '../src/lib/provider-pool';

describe('provider slot queues', () => {
  it('keeps more than twenty distinct provider marks', () => {
    const ids = providerMarks.map((mark) => mark.id);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('openai');
    expect(ids).toContain('grok');
    expect(ids).toContain('groq');
  });

  it('gives each visible slot its own non-overlapping cycle', () => {
    const queues = providerSlotQueues();
    expect(queues).toHaveLength(SLOT_COUNT);
    const seen = queues.flat().map((mark) => mark.id);
    expect(new Set(seen).size).toBe(providerMarks.length);
    for (const queue of queues) {
      expect(queue.length).toBeGreaterThan(1);
    }
    const firstIds = queues.map((queue) => queue[0]?.id);
    expect(new Set(firstIds).size).toBe(SLOT_COUNT);
  });

  it('shuffles the same way for a given seed', () => {
    const first = shuffleProviders(providerMarks, 7).map((mark) => mark.id);
    const second = shuffleProviders(providerMarks, 7).map((mark) => mark.id);
    expect(first).toEqual(second);
    expect(first).not.toEqual(providerMarks.map((mark) => mark.id));
  });
});
