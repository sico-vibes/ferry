import { MockNotFoundError } from '../errors.js';
import type { Message, MessagePart } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createApprovalsDomain(_store: MockStore, deps: MockDeps): FerryClient['approvals'] {
  const { approvalWaiters, before, persist, emit, sessionDetail, state, clock } = deps;
  return {
    async pending() {
      await before();
      const entries: import('@ferry/shared').ApprovalsPending['entries'] = [];
      for (const s of state.sessions)
        for (const m of state.messages.get(s.id) ?? [])
          for (const p of m.parts)
            if (p.type === 'approval_request' && p.state === 'pending')
              entries.push({
                sessionId: s.id,
                title: s.title,
                partId: p.id,
                kind: p.kind,
                summary: p.summary,
                detail: p.detail,
                risk: p.risk,
              });
      return { entries, updatedAt: clock.now().toISOString() };
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
      approvalWaiters.get(`${sessionId}:${partId}`)?.(found.state);
      approvalWaiters.delete(`${sessionId}:${partId}`);
      persist();
    },
  };
}
