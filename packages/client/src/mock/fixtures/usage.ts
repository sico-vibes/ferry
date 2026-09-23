import type { HandoffStat } from '@ferry/shared';
export const handoffStats: HandoffStat[] = [
  { reason: 'quota', count: 9 },
  { reason: 'rate_limit', count: 4 },
  { reason: 'error', count: 1 },
  { reason: 'context', count: 2 },
  { reason: 'capability', count: 1 },
  { reason: 'manual', count: 0 },
];
