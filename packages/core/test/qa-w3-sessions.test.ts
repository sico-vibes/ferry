import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRpcFerryClient } from '@ferry/client';
import { createCoreHost, createMemoryTransportPair } from '../src/index.js';
import type { Session } from '@ferry/shared';
import {
  cancelAndSettle,
  delay,
  sessionStatus,
  startHarness,
  textTurn,
  toolTurn,
  waitFor,
} from './qa-w3-harness.js';

describe('QA W3 sessions: run lifecycle and races', () => {
  it('rejects a second send while a run is active instead of starting a second loop', async () => {
    const h = await startHarness({
      turns: [textTurn('one two three four five', { delayMs: 200 })],
    });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const first = h.rpc.sessions.send(session.id, { text: 'first prompt' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'running');
      await expect(
        h.rpc.sessions.send(session.id, { text: 'second prompt' }),
      ).rejects.toMatchObject({ code: -32010, kind: 'conflict' });
      await first;
      await cancelAndSettle(h, session.id);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('treats a second cancel as a no-op and settles the run', async () => {
    const h = await startHarness({ turns: [textTurn('slow response', { delayMs: 200 })] });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      void h.rpc.sessions.send(session.id, { text: 'cancel me' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'running');
      let idle = 0;
      const off = h.rpc.on('session.status', (event) => {
        if (event.id === session.id && event.status === 'idle') idle += 1;
      });
      await h.rpc.sessions.cancel(session.id);
      await expect(h.rpc.sessions.cancel(session.id)).resolves.toBeUndefined();
      await waitFor(() => idle >= 3, 10_000);
      off();
      await delay(150);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('waits for a cancelled loop before accepting the next send', async () => {
    const h = await startHarness({
      turns: [textTurn('cancel this request', { delayMs: 2_000 }), textTurn('second run')],
    });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.sessions.send(session.id, { text: 'first prompt' });
      await waitFor(() => h.server.requests.length === 1);
      await h.rpc.sessions.cancel(session.id);
      await h.rpc.sessions.send(session.id, { text: 'second prompt' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'idle');
      expect(h.server.requests).toHaveLength(2);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('does not emit unhandled rejections when stopping an active run', async () => {
    const h = await startHarness({
      turns: [textTurn('run will be stopped', { delayMs: 2_000 })],
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.sessions.send(session.id, { text: 'stop this run' });
      await waitFor(() => h.server.requests.length === 1);
      await h.host.stop();
      await delay(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
      await h.close();
    }
  }, 30_000);

  it('deleting a running session removes it and never resurrects it', async () => {
    const h = await startHarness({ turns: [textTurn('still going', { delayMs: 200 })] });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      void h.rpc.sessions.send(session.id, { text: 'delete me' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'running');
      await h.rpc.sessions.remove(session.id);
      await delay(1500);
      await expect(h.rpc.sessions.get(session.id)).rejects.toMatchObject({ kind: 'not_found' });
      expect((await h.rpc.sessions.list()).map((item) => item.id)).not.toContain(session.id);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('applies rename, star and pin independently while a run is active', async () => {
    const h = await startHarness({ turns: [textTurn('working on it', { delayMs: 200 })] });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      void h.rpc.sessions.send(session.id, { text: 'metadata race' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'running');
      await h.rpc.sessions.rename(session.id, 'Renamed during run');
      await h.rpc.sessions.setStarred(session.id, true);
      await h.rpc.sessions.setPinned(session.id, true);
      const current = (await h.rpc.sessions.get(session.id)).session;
      expect(current).toMatchObject({
        title: 'Renamed during run',
        starred: true,
        pinned: true,
      });
      await cancelAndSettle(h, session.id);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('search matches regex metacharacters literally and folds unicode case', async () => {
    const h = await startHarness({ turns: [textTurn('hello')] });
    try {
      const a = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const b = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const c = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.sessions.rename(a.id, 'Release (v1.2) [beta]?');
      await h.rpc.sessions.rename(b.id, 'Unrelated notes');
      await h.rpc.sessions.rename(c.id, 'Ünicode Çafé');
      const literal = await h.rpc.sessions.search({ query: '(v1.2)' });
      expect(literal.map((item) => item.id)).toEqual([a.id]);
      const star = await h.rpc.sessions.search({ query: '.*' });
      expect(star).toEqual([]);
      const unicode = await h.rpc.sessions.search({ query: 'ünicode' });
      expect(unicode.map((item) => item.id)).toEqual([c.id]);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('marks a run that was in flight at restart as interrupted (error), not resumable', async () => {
    const h = await startHarness({ turns: [textTurn('hello')] });
    let secondHost: Awaited<ReturnType<typeof createCoreHost>> | undefined;
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.sessions.send(session.id, { text: 'durable prompt' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'idle');
      const stored = h.services.sessions.get(session.id);
      if (!stored) throw new Error('session missing');
      h.services.sessions.put({ ...stored, status: 'running' });
      h.rpc.close();
      await h.host.stop();
      const [coreTransport, clientTransport] = createMemoryTransportPair();
      secondHost = await createCoreHost({
        dataDir: h.dataDir,
        transport: coreTransport,
        env: h.services.env,
      });
      const rpc2 = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
      await rpc2.hello;
      const after = await rpc2.sessions.get(session.id);
      expect(after.session.status).toBe('error');
      // Durable prior messages remain readable after the crash.
      expect(after.messages.length).toBeGreaterThan(0);
      rpc2.close();
    } finally {
      if (secondHost) await secondHost.stop();
      await h.server.stop();
      await rm(h.root, { recursive: true, force: true, maxRetries: 8 });
    }
  }, 30_000);

  it('persists a very large prompt without crashing or truncating it', async () => {
    const h = await startHarness({ turns: [textTurn('ok')] });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const huge = `ünïcode ${'x'.repeat(200_000)}`;
      await h.rpc.sessions.send(session.id, { text: huge });
      const detail = await h.rpc.sessions.get(session.id);
      const userText = detail.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .find((text) => text.includes('ünïcode'));
      expect(userText).toBe(huge);
      await h.rpc.sessions.cancel(session.id);
      await delay(1200);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('delivers session.delta exactly once, in order, and stops after the run settles', async () => {
    const h = await startHarness({ turns: [textTurn('alpha beta gamma')] });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      const deltas: string[] = [];
      const statuses: Session['status'][] = [];
      const offDelta = h.rpc.on('session.delta', (event) => {
        if (event.sessionId === session.id) deltas.push(event.textDelta);
      });
      const offStatus = h.rpc.on('session.status', (event) => {
        if (event.id === session.id) statuses.push(event.status);
      });
      await h.rpc.sessions.send(session.id, { text: 'stream this' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'idle');
      const countAtSettle = deltas.length;
      await delay(200);
      offDelta();
      offStatus();
      expect(deltas.join('')).toBe('alpha beta gamma');
      expect(countAtSettle).toBeGreaterThan(0);
      expect(deltas.length).toBe(countAtSettle);
      expect(statuses.at(-1)).toBe('idle');
    } finally {
      await h.close();
    }
  }, 30_000);

  it('reports a structured error status when the provider fails', async () => {
    const h = await startHarness({
      turns: [{ status: 500, body: { error: { message: 'boom' } } }],
    });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.sessions.send(session.id, { text: 'fail please' });
      await waitFor(async () => {
        const status = await sessionStatus(h.rpc, session.id);
        return status === 'error' || status === 'idle';
      });
      expect(await sessionStatus(h.rpc, session.id)).toBe('error');
    } finally {
      await h.close();
    }
  }, 30_000);

  it('never leaves a dangling approval part resolved to pending after a denied tool call', async () => {
    // Sanity: a denied approval is reflected as denied in the durable message parts.
    const h = await startHarness({
      turns: [toolTurn('write_file', { path: 'notes.txt', content: 'hi' }), textTurn('done')],
    });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      let approvalPartId: string | undefined;
      const off = h.rpc.on('approval.request', (event) => {
        if (event.sessionId === session.id) approvalPartId = event.part.id;
      });
      await h.rpc.sessions.send(session.id, { text: 'write a note' });
      await waitFor(() => approvalPartId !== undefined);
      await h.rpc.approvals.respond(session.id, approvalPartId as never, 'deny');
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'idle');
      off();
      const detail = await h.rpc.sessions.get(session.id);
      const approval = detail.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'approval_request' && part.id === approvalPartId);
      expect(approval).toMatchObject({ type: 'approval_request', state: 'denied' });
    } finally {
      await h.close();
    }
  }, 30_000);

  it('cancel after a completed run is harmless', async () => {
    const h = await startHarness({ turns: [textTurn('quick')] });
    try {
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.sessions.send(session.id, { text: 'go' });
      await waitFor(async () => (await sessionStatus(h.rpc, session.id)) === 'idle');
      const id = session.id;
      await expect(h.rpc.sessions.cancel(id)).resolves.toBeUndefined();
      await expect(h.rpc.sessions.cancel(id)).resolves.toBeUndefined();
    } finally {
      await h.close();
    }
  }, 30_000);
});
