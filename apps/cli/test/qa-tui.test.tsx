import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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

async function submit(app: ChatApp, text: string): Promise<void> {
  app.stdin.write(text);
  await wait(5);
  app.stdin.write('\r');
}

describe('@ferry/cli Ink TUI slash commands', () => {
  let app: ChatApp | undefined;

  afterEach(() => {
    app?.unmount();
    app = undefined;
  });

  it('/help lists the available commands', async () => {
    app = await openChat();
    await submit(app, '/help');
    const current = app;
    await waitForFrame(current, (frame) => frame.includes('/profile <name>'));
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

  it('/clear starts a fresh chat', async () => {
    app = await openChat();
    await submit(app, '/clear');
    const current = app;
    await waitForFrame(current, (frame) => frame.includes('Started a fresh chat.'));
    expect(current.lastFrame()).toContain('Started a fresh chat.');
  });
});
