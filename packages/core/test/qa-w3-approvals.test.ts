import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PartId, SessionId } from '@ferry/shared';
import { delay, startHarness, textTurn, toolTurn, waitFor } from './qa-w3-harness.js';

async function pendingApproval(
  h: Awaited<ReturnType<typeof startHarness>>,
  sessionId: SessionId,
): Promise<PartId> {
  let partId: PartId | undefined;
  const off = h.rpc.on('approval.request', (event) => {
    if (event.sessionId === sessionId) partId = event.part.id;
  });
  await h.rpc.sessions.send(sessionId, { text: 'needs approval' });
  await waitFor(() => partId !== undefined);
  off();
  if (!partId) throw new Error('approval never arrived');
  return partId;
}

describe('QA W3 approvals: adversarial responses', () => {
  it('rejects an approval id that does not exist', async () => {
    const h = await startHarness({ turns: [textTurn('hello')] });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.sessions.send(session.id, { text: 'go' });
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      await expect(
        h.rpc.approvals.respond(session.id, 'part_does_not_exist' as PartId, 'allow_once'),
      ).rejects.toMatchObject({ kind: 'not_found' });
    } finally {
      await h.close();
    }
  }, 30_000);

  it('rejects an approval response that names a different session', async () => {
    const h = await startHarness({
      turns: [toolTurn('write_file', { path: 'a.txt', content: '1' }), textTurn('done')],
    });
    try {
      const owner = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const other = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const partId = await pendingApproval(h, owner.id);
      await expect(h.rpc.approvals.respond(other.id, partId, 'deny')).rejects.toMatchObject({
        kind: 'not_found',
      });
      await h.rpc.approvals.respond(owner.id, partId, 'deny');
      await waitFor(async () => (await h.rpc.sessions.get(owner.id)).session.status === 'idle');
      await delay(300);
    } finally {
      await h.close();
    }
  }, 30_000);

  it.fails(
    'rejects a second response to an already-resolved approval',
    async () => {
      // BUG: approvals.respond has no guard on the persisted part state. A second
      // response finds the same approval_request part and silently rewrites its
      // state (and can persist a new allow_always rule) instead of rejecting as
      // a conflict. Re-resolving must be refused, not reapplied.
      const h = await startHarness({
        turns: [toolTurn('write_file', { path: 'a.txt', content: '1' }), textTurn('done')],
      });
      try {
        const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
        const partId = await pendingApproval(h, session.id);
        await h.rpc.approvals.respond(session.id, partId, 'deny');
        const second = await h.rpc.approvals.respond(session.id, partId, 'allow_once').then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        );
        await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
        await delay(400);
        expect(second).toBe('rejected');
      } finally {
        await h.close();
      }
    },
    30_000,
  );

  it.fails(
    'emits approval.request once, only while the approval is pending',
    async () => {
      // BUG: the agent emits an approval_request part twice (once pending, once
      // resolved) and sessions.register forwards every approval_request part as a
      // approval.request event. A UI subscribed to approval.request therefore sees
      // a duplicate request with state 'denied'/'allowed_*' and can reopen a modal
      // for an approval the user already answered.
      const h = await startHarness({
        turns: [toolTurn('write_file', { path: 'a.txt', content: '1' }), textTurn('done')],
      });
      try {
        const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
        const states: string[] = [];
        const off = h.rpc.on('approval.request', (event) => {
          if (event.sessionId === session.id) states.push(event.part.state);
        });
        const partId = await pendingApproval(h, session.id);
        await h.rpc.approvals.respond(session.id, partId, 'deny');
        await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
        off();
        expect(states).toEqual(['pending']);
        await delay(400);
      } finally {
        await h.close();
      }
    },
    30_000,
  );

  it('delivers a structured denial to the model and marks the tool call failed', async () => {
    const h = await startHarness({
      turns: [toolTurn('write_file', { path: 'a.txt', content: '1' }), textTurn('done')],
    });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const partId = await pendingApproval(h, session.id);
      await h.rpc.approvals.respond(session.id, partId, 'deny');
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      const detail = await h.rpc.sessions.get(session.id);
      const toolPart = detail.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool_call');
      expect(toolPart).toMatchObject({ type: 'tool_call', tool: 'write_file', status: 'failed' });
      if (toolPart?.type === 'tool_call') {
        expect(toolPart.output?.text).toMatch(/denied/i);
      }
      // The model's next request must include the denial, not a silent success.
      const followUp = h.server.requests.at(1);
      expect(JSON.stringify(followUp?.body ?? {})).toMatch(/User denied/);
      await expect(readFile(join(h.workspacePath, 'a.txt'), 'utf8')).rejects.toThrow();
      await delay(400);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('allow_always persists only for the exact approved path scope', async () => {
    const h = await startHarness({
      turns: [
        toolTurn('write_file', { path: 'a.txt', content: '1' }),
        textTurn('done one'),
        toolTurn('write_file', { path: 'a.txt', content: '2' }),
        toolTurn('write_file', { path: 'b.txt', content: '3' }),
        textTurn('done two'),
      ],
    });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const seen: string[] = [];
      const off = h.rpc.on('approval.request', (event) => {
        if (event.sessionId !== session.id) return;
        if (event.part.state !== 'pending') return;
        seen.push(event.part.detail);
        const decision = seen.length === 1 ? 'allow_always' : 'deny';
        void h.rpc.approvals.respond(session.id, event.part.id, decision);
      });
      await h.rpc.sessions.send(session.id, { text: 'first' });
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      await h.rpc.sessions.send(session.id, { text: 'second' });
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      off();
      expect(seen).toEqual(['a.txt', 'b.txt']);
      const rules = h.services.settings.get(`permission-rules:${h.workspaceId}`);
      expect(rules).toEqual([{ pattern: 'a.txt', mode: 'allow' }]);
      await expect(readFile(join(h.workspacePath, 'a.txt'), 'utf8')).resolves.toBe('2');
      await expect(readFile(join(h.workspacePath, 'b.txt'), 'utf8')).rejects.toThrow();
      await delay(400);
    } finally {
      await h.close();
    }
  }, 30_000);

  it.fails(
    'resolves a pending approval when the core stops instead of hanging',
    async () => {
      // BUG: CoreHost.stop disposes services but never aborts the per-session
      // AbortController that sessions.register keeps. A run parked on
      // requestApproval therefore never resolves; the approval listener lives in
      // a closure the stop path cannot reach. Stopping the core must deny/cancel
      // the pending approval.
      const h = await startHarness({
        turns: [toolTurn('write_file', { path: 'a.txt', content: '1' })],
      });
      try {
        const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
        let partId: PartId | undefined;
        let denied = false;
        const off = h.rpc.on('session.part', (event) => {
          if (
            event.sessionId === session.id &&
            event.part.type === 'approval_request' &&
            event.part.state === 'denied'
          )
            denied = true;
        });
        h.rpc.on('approval.request', (event) => {
          if (event.sessionId === session.id) partId = event.part.id;
        });
        await h.rpc.sessions.send(session.id, { text: 'needs approval' });
        await waitFor(() => partId !== undefined);
        await h.host.stop();
        await delay(800);
        off();
        expect(denied).toBe(true);
      } finally {
        await h.close();
      }
    },
    30_000,
  );
});
