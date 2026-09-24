import type { DelegationRun, RunId } from '@ferry/shared';
import type { FerryClient } from '@ferry/client';
import { describe, expect, it, vi } from 'vitest';
import { decideReview } from './reviewActions';

describe('decideReview', () => {
  it.each([
    ['accepted', undefined],
    ['rejected', undefined],
    ['rework', 'Run the focused test suite before returning.'],
  ] as const)('forwards the %s decision to the delegation client', async (decision, brief) => {
    const decide = vi
      .fn<FerryClient['delegation']['decide']>()
      .mockResolvedValue({} as DelegationRun);
    const client = { delegation: { decide } } as unknown as FerryClient;
    await decideReview(client, 'run_demo' as RunId, decision, brief);
    expect(decide).toHaveBeenCalledWith('run_demo', decision, brief);
  });
});
