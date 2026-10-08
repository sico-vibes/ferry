import React from 'react';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { interactive } from '../src/interactive.js';
import { Chat } from '../src/tui.js';

const mounted = vi.hoisted(() =>
  vi.fn((_element: unknown, _options: unknown) => ({ waitUntilExit: () => Promise.resolve() })),
);
vi.mock('ink', async (original) => ({
  ...(await original<typeof import('ink')>()),
  render: mounted,
}));
vi.mock('../src/terminal.js', () => ({
  selectTerminalStreams: () => ({
    stdin: process.stdin,
    stdout: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    dispose: () => undefined,
  }),
}));
afterEach(() => {
  mounted.mockClear();
  vi.restoreAllMocks();
});

describe('interactive startup', () => {
  it('--no-project opens a Recent without opening or trusting the current folder', async () => {
    const client = createMockFerryClient();
    const open = vi.spyOn(client.workspaces, 'open');
    expect(await interactive(client, process.cwd(), 'mock', { noProject: true })).toBe(0);
    expect(open).not.toHaveBeenCalled();
    const element = mounted.mock.calls[0]?.[0] as React.ReactElement<
      React.ComponentProps<typeof Chat>
    >;
    expect(element.props.workspace).toBeNull();
    expect(element.props.initialSession).toBeUndefined();
  });
  it('opens the current folder and --continue resumes the newest chat for that folder only', async () => {
    const client = createMockFerryClient();
    const workspace = await client.workspaces.open(process.cwd());
    await client.workspaces.trust(workspace.id);
    const first = await client.sessions.create({ workspaceId: workspace.id, title: 'First chat' });
    const latest = await client.sessions.create({
      workspaceId: workspace.id,
      title: 'Latest chat',
    });
    await client.sessions.create({ workspaceId: null, title: 'Recent' });
    const rows = await client.sessions.list();
    const list = vi.spyOn(client.sessions, 'list').mockResolvedValue(
      rows
        .filter((row) => row.id === first.id || row.id === latest.id)
        .map((row) => ({
          ...row,
          updatedAt: row.id === latest.id ? '2026-10-08T12:00:00Z' : '2026-10-07T12:00:00Z',
        })),
    );
    expect(await interactive(client, process.cwd(), 'mock', { continue: true })).toBe(0);
    expect(list).toHaveBeenCalledWith({ workspaceId: workspace.id });
    const element = mounted.mock.calls[0]?.[0] as React.ReactElement<
      React.ComponentProps<typeof Chat>
    >;
    expect(element.props.workspace?.path).toBe(workspace.path);
    expect(element.props.initialSession?.id).toBe(latest.id);
  });
});
