import type { RunId } from '@ferry/shared';
import type { FerryClient } from '@ferry/client';

export type ReviewDecision = 'accepted' | 'rejected' | 'rework';

export function decideReview(
  client: FerryClient,
  runId: RunId,
  decision: ReviewDecision,
  reworkBrief?: string,
) {
  return client.delegation.decide(runId, decision, reworkBrief);
}
