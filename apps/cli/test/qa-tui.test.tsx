import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createMockFerryClient } from '@ferry/client';
import { Chat } from '../src/tui.js';

type ChatApp = ReturnType<typeof render>;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFrame(
  app: ChatApp,
  predicate: (frame: string) => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate(app.lastFrame() ?? '')) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for the UI frame. Last frame:\n${app.lastFrame() ?? ''}`);
}

async function openChat(): Promise<ChatApp> {
  const client = createMockFerryClient();
  const workspace = await client.workspaces.open(process.cwd());
  const profile = (await client.profiles.list())[0];
  if (!profile) throw new Error('fixture profile missing');
  const app = render(<Chat client={client} workspace={workspace} profile={profile} />);
  await waitForFrame(app, (frame) => !frame.includes('loading capacity'));
  await wait(20);
  return app;
}

async function submit(app: ChatApp, text: string, enter = '\r'): Promise<void> {
  app.stdin.write(text);
  await wait(5);
  app.stdin.write(enter);
}

describe('@ferry/cli Ink TUI slash commands', () => {
  let app: ChatApp | undefined;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.restoreAllMocks();
  });

  it('/help lists the available commands', async () => {
    app = await openChat();
    await submit(app, '/help');
    const current = app;
    await waitForFrame(current, (frame) => frame.includes('/model [number|ref]'));
    expect(current.lastFrame()).toContain('/help');
  });

  it('/profile with an unknown name reports the available profiles', async () => {
    app = await openChat();
    await submit(app, '/profile definitely-not-a-profile');
    const current = app;
    await waitForFrame(current, (frame) => frame.includes('Profile not found'));
    expect(current.lastFrame()).toContain('Available:');
  });

  it('/undo with no checkpoint explains there is nothing to restore', async () => {
    app = await openChat();
    await submit(app, '/undo');
    const current = app;
    await waitForFrame(current, (frame) => frame.includes('No checkpoint'));
    expect(current.lastFrame()).toContain('to restore.');
  });

  it('submits when the terminal reports Enter as LF', async () => {
    app = await openChat();
    await submit(app, 'hello', '\n');
    const current = app;
    await waitForFrame(current, (frame) => frame.includes('you: hello'));
    expect(current.lastFrame()).not.toContain('› hello');
  });

  it.each(['\r', '\n', '\r\n'])(
    'submits text and Enter that arrive in one chunk (%j), once',
    async (enter) => {
      app = await openChat();
      app.stdin.write(`hello${enter}`);
      const current = app;
      await waitForFrame(current, (frame) => frame.includes('you: hello'));
      await wait(30);
      expect(current.lastFrame()?.split('you: hello').length).toBe(2);
      expect(current.lastFrame()).not.toContain('› hello');
    },
  );

  it('creates the session lazily when the first message is submitted', async () => {
    const client = createMockFerryClient();
    const workspace = await client.workspaces.open(process.cwd());
    const profile = (await client.profiles.list())[0];
    if (!profile) throw new Error('fixture profile missing');
    const create = vi.spyOn(client.sessions, 'create');
    app = render(<Chat client={client} workspace={workspace} profile={profile} />);
    const current = app;
    await waitForFrame(current, (frame) => !frame.includes('loading capacity'));
    expect(create).not.toHaveBeenCalled();

    await submit(current, 'hello');
    await waitForFrame(current, (frame) => frame.includes('you: hello'));
    expect(create).toHaveBeenCalledOnce();
  });

  it('shows a visible error when lazy session creation fails', async () => {
    const client = createMockFerryClient();
    const workspace = await client.workspaces.open(process.cwd());
    const profile = (await client.profiles.list())[0];
    if (!profile) throw new Error('fixture profile missing');
    vi.spyOn(client.sessions, 'create').mockRejectedValue(new Error('session creation failed'));
    app = render(<Chat client={client} workspace={workspace} profile={profile} />);
    const current = app;
    await waitForFrame(current, (frame) => !frame.includes('loading capacity'));

    await submit(current, 'hello');
    await waitForFrame(current, (frame) => frame.includes('session creation failed'));
    expect(current.lastFrame()).not.toContain('you: hello');
  });

  it('shows a visible error when sending the first message fails', async () => {
    const client = createMockFerryClient();
    const workspace = await client.workspaces.open(process.cwd());
    const profile = (await client.profiles.list())[0];
    if (!profile) throw new Error('fixture profile missing');
    vi.spyOn(client.sessions, 'send').mockRejectedValue(new Error('message send failed'));
    app = render(<Chat client={client} workspace={workspace} profile={profile} />);
    const current = app;
    await waitForFrame(current, (frame) => !frame.includes('loading capacity'));

    await submit(current, 'hello');
    await waitForFrame(current, (frame) => frame.includes('message send failed'));
    expect(current.lastFrame()).toContain('you: hello');
  });

  it('/clear starts a fresh chat', async () => {
    app = await openChat();
    await submit(app, '/clear');
    const current = app;
    await waitForFrame(current, (frame) => frame.includes('Started a fresh chat.'));
    expect(current.lastFrame()).toContain('Started a fresh chat.');
  });
});
