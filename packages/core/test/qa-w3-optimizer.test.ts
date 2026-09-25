import { describe, expect, it } from 'vitest';
import { startHarness, type CoreHarness } from './qa-w3-harness.js';

interface StoredEvent {
  id: string;
  sessionId: string;
  kind: string;
  beforeTokens?: number;
  afterTokens?: number;
  timestamp?: string;
}

function putEvent(h: CoreHarness, event: StoredEvent): void {
  h.services.optimizerEvents.put(event);
}

describe('QA W3 optimizer: honest stats', () => {
  it('reports demo data before any real optimizer event exists', async () => {
    const h = await startHarness();
    try {
      const stats = await h.rpc.optimizer.stats();
      expect(stats.demo).toBe(true);
      expect(stats.today.savedTokens).toBe(0);
      expect(stats.byOptimizer).toEqual([]);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('flips demo to false once a real token-counted event exists', async () => {
    const h = await startHarness();
    try {
      putEvent(h, {
        id: 'opt_1',
        sessionId: 'session_qa',
        kind: 'tool-output',
        beforeTokens: 1_000,
        afterTokens: 400,
        timestamp: new Date().toISOString(),
      });
      const stats = await h.rpc.optimizer.stats();
      expect(stats.demo).toBe(false);
      expect(stats.today.savedTokens).toBe(600);
      expect(stats.today.percent).toBeCloseTo(60, 5);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('never reports negative savings or percent outside 0..100', async () => {
    const h = await startHarness();
    try {
      putEvent(h, {
        id: 'opt_neg',
        sessionId: 'session_qa',
        kind: 'negative',
        beforeTokens: 10,
        afterTokens: 50,
      });
      putEvent(h, {
        id: 'opt_pos',
        sessionId: 'session_qa',
        kind: 'positive',
        beforeTokens: 100,
        afterTokens: 40,
      });
      const stats = await h.rpc.optimizer.stats();
      expect(stats.demo).toBe(false);
      expect(stats.today.savedTokens).toBeGreaterThanOrEqual(0);
      expect(stats.today.percent).toBeGreaterThanOrEqual(0);
      expect(stats.today.percent).toBeLessThanOrEqual(100);
      for (const group of stats.byOptimizer) {
        expect(group.savedTokens).toBeGreaterThanOrEqual(0);
        expect(group.percent).toBeGreaterThanOrEqual(0);
        expect(group.percent).toBeLessThanOrEqual(100);
      }
      // The negative-savings group contributes zero, never a credit.
      expect(stats.byOptimizer.find((group) => group.id === 'negative')?.savedTokens).toBe(0);
      expect(stats.byOptimizer.find((group) => group.id === 'positive')?.savedTokens).toBe(60);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('keeps demo true for events that carry no token measurements', async () => {
    const h = await startHarness();
    try {
      putEvent(h, { id: 'opt_meta', sessionId: 'session_qa', kind: 'filter' });
      const stats = await h.rpc.optimizer.stats();
      expect(stats.demo).toBe(true);
      expect(stats.byOptimizer).toEqual([]);
    } finally {
      await h.close();
    }
  }, 30_000);
});
