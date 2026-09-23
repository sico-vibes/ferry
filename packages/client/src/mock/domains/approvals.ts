import { MockNotFoundError } from '../errors.js';
import type { Message, MessagePart } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createApprovalsDomain(_store: MockStore, deps: MockDeps): FerryClient['approvals'] {
  const { approvalWaiters, before, persist, emit, sessionDetail } = deps;
  return {
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
