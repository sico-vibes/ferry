import { describe, expect, it } from 'vitest';
import type { Message } from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';

const now = new Date('2026-09-23T21:47:00.000Z');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const makeClient = () =>
  createMockFerryClient({ clock: createFakeClock(now).clock, behavior: 'test' });

describe('QA sessions domain', () => {
  it('lists sessions newest first by updatedAt', async () => {
    const client = makeClient();
    const sessions = await client.sessions.list();
    const updatedAt = sessions.map((session) => session.updatedAt);
    expect(updatedAt).toEqual([...updatedAt].sort((a, b) => b.localeCompare(a)));
  });

  it('queries case-insensitively across title and preview', async () => {
    const client = makeClient();
    const all = await client.sessions.list();
    const byTitle = all.find((session) => session.title.includes('Auth'));
    const byPreview = all.find((session) => session.preview.includes('checkout'));
    if (!byTitle || !byPreview) throw new Error('Session fixtures missing');

    const titleHits = await client.sessions.list({ query: 'aUtH rEf' });
    expect(titleHits.map((session) => session.id)).toContain(byTitle.id);

    const previewHits = await client.sessions.list({ query: 'CHECKOUT' });
    expect(previewHits.map((session) => session.id)).toContain(byPreview.id);

    expect(await client.sessions.list({ query: 'zzzz-no-match' })).toHaveLength(0);
  });

  it('sends a user message, streams an assistant reply, then returns to idle', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
    const workspace = (await client.workspaces.list())[0];
    if (!workspace) throw new Error('Workspace fixture missing');
    const session = await client.sessions.create({ workspaceId: workspace.id, title: 'QA send' });

    const messages: Message[] = [];
    const deltas: string[] = [];
    client.on('session.message', (payload) => messages.push(payload.message));
    client.on('session.delta', (payload) => deltas.push(payload.textDelta));

    await client.sessions.send(session.id, { text: 'Hello QA' });
    expect((await client.sessions.get(session.id)).session.status).toBe('running');

    fake.advance(600);
    await flush();
    fake.advance(150);
    await flush();
    fake.advance(150);
    await flush();
    fake.advance(150);
    await flush();

    const detail = await client.sessions.get(session.id);
    expect(detail.session.status).toBe('idle');
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(deltas.join('')).toContain('Hello QA');
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('cancels during a run, stays idle, and leaves no timers behind', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
    const workspace = (await client.workspaces.list())[0];
    if (!workspace) throw new Error('Workspace fixture missing');
    const session = await client.sessions.create({ workspaceId: workspace.id, title: 'QA cancel' });

    const events: string[] = [];
    client.on('session.message', () => events.push('message'));
    client.on('session.delta', () => events.push('delta'));
    client.on('session.updated', () => events.push('updated'));

    await client.sessions.send(session.id, { text: 'Cancel me' });
    fake.advance(600);
    await flush();

    await client.sessions.cancel(session.id);
    expect((await client.sessions.get(session.id)).session.status).toBe('idle');

    const before = events.length;
    fake.advance(100_000);
    await flush();
    expect(events.length).toBe(before);
    expect((await client.sessions.get(session.id)).session.status).toBe('idle');
  });
});
