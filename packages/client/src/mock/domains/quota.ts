import type { FerryClient } from '../../ferry-client.js';
import type { HandoffStat, Provider } from '@ferry/shared';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createQuotaDomain(_store: MockStore, deps: MockDeps): FerryClient['quota'] {
  const { clock, rng, before, capacity } = deps;
  return {
    async capacity() {
      await before();
      return capacity();
    },
    async history(days) {
      await before();
      const providers = ['gemini', 'openrouter', 'nvidia', 'cerebras', 'groq', 'opencode-go'];
      return Array.from({ length: Math.max(0, Math.min(14, Math.floor(days))) }, (_, d) =>
        providers.map((id) => ({
          date: new Date(
            clock.now().getTime() - (Math.min(14, Math.floor(days)) - d - 1) * 86400000,
          )
            .toISOString()
            .slice(0, 10),
          providerId: id as Provider['id'],
          requests: rng.int(10, 170),
          inputTokens: rng.int(1000, 50000),
          outputTokens: rng.int(500, 25000),
          costUsd: id === 'opencode-go' ? Number((0.4 + rng.next() * 1.4).toFixed(2)) : 0,
        })),
      ).flat();
    },
    async handoffs() {
      await before();
      return [
        { reason: 'quota', count: 9 },
        { reason: 'rate_limit', count: 4 },
        { reason: 'error', count: 1 },
        { reason: 'context', count: 2 },
        { reason: 'capability', count: 1 },
        { reason: 'manual', count: 0 },
      ] satisfies HandoffStat[];
    },
  };
}
