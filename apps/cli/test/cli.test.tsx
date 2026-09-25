import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createMockFerryClient, createPlaybackRunner } from '@ferry/client';
import { runPrompt } from '../src/main.js';
import { ApprovalPrompt, Chat } from '../src/tui.js';
import { formatCapacity, statusLine } from '../src/format.js';

function client() {
  return createMockFerryClient({
    behavior: 'live',
    latencyMs: 0,
    scenarioRunner: createPlaybackRunner({ speed: 0 }),
  });
}

describe('@ferry/cli', () => {
  afterEach(() => vi.restoreAllMocks());

  it('formats quota as a capacity bar with a percentage', async () => {
    const text = formatCapacity(await client().quota.capacity());
    expect(text).toContain('64%');
  });

  it('renders the profile prompt and status line', async () => {
    const api = client();
    const workspace = await api.workspaces.open(process.cwd());
    const profile = (await api.profiles.list())[0];
    if (!profile) throw new Error('fixture profile missing');
    const app = render(<Chat client={api} workspace={workspace} profile={profile} />);
    expect(app.lastFrame()).toContain(profile.name);
    expect(statusLine(profile.name, 'auto', await api.quota.capacity())).toContain('steps left');
    app.unmount();
  });

  it('renders the approval prompt', () => {
    const app = render(<ApprovalPrompt summary="Run tests" />);
    expect(app.lastFrame()).toContain('Approval: Run tests');
    app.unmount();
  });

  it('streams a mock scenario to completion with exit code zero', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runPrompt(client(), 'Explain the request routing', true);
    expect(code).toBe(0);
    const rows = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
    const events = rows.map((row) => JSON.parse(row) as { type?: string });
    expect(events.some((event) => event.type === 'session.delta')).toBe(true);
  });

  it('returns approval exit code 3 for an approval-required scenario', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runPrompt(client(), 'Fix the flaky tests', true);
    expect(code).toBe(3);
  });

  it('honors full_auto approvals and the max-step limit', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const automaticallyApproved = await runPrompt(
      client(),
      'Fix the flaky tests',
      true,
      undefined,
      process.cwd(),
      { permission: 'full_auto' },
    );
    expect(automaticallyApproved).toBe(0);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const limited = await runPrompt(
      client(),
      'Explain the request routing',
      true,
      undefined,
      process.cwd(),
      { maxSteps: 0 },
    );
    expect(limited).toBe(1);
    expect(stderr).toHaveBeenCalled();
  });
});
