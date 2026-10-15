import { ApprovalsPendingSchema } from '@ferry/shared';
import type { ApprovalsPending, Message, MessagePart } from '@ferry/shared';
import { MockNotFoundError } from '../errors.js';
import type { FerryClient } from '../../ferry-client.js';
import type { FerryEvents } from '../../events.js';
import type { MockDeps } from './deps.js';
import type { MockStore, MockState } from '../types.js';
import type { Clock } from '../clock.js';

/**
 * The actionable pending approvals across the mock store. Only pending approval parts in sessions
 * still in `awaiting_approval` are returned, so a resolved, removed or otherwise inactive session is
 * never surfaced — mirroring the core's indexed summary.
 */
export function pendingApprovalsFor(state: MockState, updatedAt: string): ApprovalsPending {
  const entries: ApprovalsPending['entries'] = [];
  const updatedBySession = new Map<string, string>();
  for (const session of state.sessions) {
    if (session.status !== 'awaiting_approval') continue;
    updatedBySession.set(session.id, session.updatedAt);
    for (const message of state.messages.get(session.id) ?? [])
      for (const part of message.parts)
        if (part.type === 'approval_request' && part.state === 'pending')
          entries.push({
            sessionId: session.id,
            title: session.title,
            partId: part.id,
            kind: part.kind,
            summary: part.summary,
            detail: part.detail,
            risk: part.risk,
          });
  }
  entries.sort((left, right) => {
    const leftUpdated = updatedBySession.get(left.sessionId) ?? '';
    const rightUpdated = updatedBySession.get(right.sessionId) ?? '';
    if (leftUpdated !== rightUpdated) return rightUpdated.localeCompare(leftUpdated);
    if (left.sessionId !== right.sessionId) return left.sessionId.localeCompare(right.sessionId);
    return left.partId.localeCompare(right.partId);
  });
  return ApprovalsPendingSchema.parse({ entries, updatedAt });
}

/** Publishes the current pending-approval snapshot after the actionable set may have changed. */
export function emitPendingApprovals(
  emit: <E extends keyof FerryEvents>(event: E, payload: FerryEvents[E]) => void,
  state: MockState,
  clock: Clock,
): void {
  emit('approvals.pending.updated', pendingApprovalsFor(state, clock.now().toISOString()));
}

export function createApprovalsDomain(_store: MockStore, deps: MockDeps): FerryClient['approvals'] {
  const { approvalWaiters, before, persist, emit, sessionDetail, state, clock } = deps;
  return {
    async pending() {
      await before();
      return pendingApprovalsFor(state, clock.now().toISOString());
    },
    async respond(sessionId, partId, decision) {
      await before();
      const detail = sessionDetail(sessionId);
      let found: Extract<MessagePart, { type: 'approval_request' }> | undefined;
      let msg: Message | undefined;
      for (const m of detail.messages)
        for (const p of m.parts)
          if (p.id === partId && p.type === 'approval_request') {
            found = p;
            msg = m;
          }
      if (!found || !msg) throw new MockNotFoundError('Approval', partId);
      found.state =
        decision === 'allow_once'
          ? 'allowed_once'
          : decision === 'allow_always'
            ? 'allowed_always'
            : 'denied';
      emit('session.part', { sessionId, messageId: msg.id, part: found });
      emitPendingApprovals(emit, state, clock);
      approvalWaiters.get(`${sessionId}:${partId}`)?.(found.state);
      approvalWaiters.delete(`${sessionId}:${partId}`);
      persist();
    },
  };
}
