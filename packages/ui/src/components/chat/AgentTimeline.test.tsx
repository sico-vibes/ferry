// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@ferry/shared';
import { AgentTimeline, buildTimelineLanes } from './AgentTimeline';

const call = (id: string, tool: string): AgentEvent => ({
  id: `use-${id}`,
  type: 'tool_use',
  timestamp: '2026-09-30T10:00:00.000Z',
  callId: id,
  tool,
  input: {},
});
const result = (id: string, output: string, truncated = false): AgentEvent => ({
  id: `result-${id}`,
  type: 'tool_result',
  timestamp: '2026-09-30T10:00:01.000Z',
  callId: id,
  output,
  ...(truncated ? { truncated: true, recoveryHandle: 'recovery:test' } : {}),
});

describe('AgentTimeline', () => {
  it('pairs tool results by callId, groups three same-tool calls, and keeps shell calls separate', () => {
    const events = [
      call('a', 'read_file'),
      call('b', 'read_file'),
      call('c', 'read_file'),
      call('shell-a', 'run_command'),
      call('shell-b', 'run_command'),
      call('shell-c', 'run_command'),
      result('a', 'A'),
    ];
    const lanes = buildTimelineLanes(events);
    const first = lanes.tools[0];
    assert.ok(first && 'type' in first);
    expect(first).toMatchObject({ type: 'group', tool: 'read_file' });
    expect(first.steps).toHaveLength(3);
    expect(first.steps[0]).toMatchObject({ call: { callId: 'a' }, result: { output: 'A' } });
    expect(lanes.tools.slice(1)).toHaveLength(3);
    expect(lanes.tools.slice(1).every((item) => 'call' in item)).toBe(true);
  });

  it('keeps activity details collapsed until expanded', () => {
    render(
      <AgentTimeline
        events={[
          {
            id: 'thinking-1',
            type: 'thinking',
            timestamp: '2026-09-30T10:00:00.000Z',
            content: 'Reviewing the changed files.',
          },
        ]}
      />,
    );
    const toggle = screen.getByRole('button', { name: /Worked for|Working/ });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(screen.queryByText('28 chars · ~7 tokens'), null);
    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('28 chars · ~7 tokens'));
  });

  it('hides tool rows, thinking, and usage until the activity disclosure is expanded', () => {
    const events: AgentEvent[] = [
      {
        id: 'thinking-hidden',
        type: 'thinking',
        timestamp: '2026-09-30T10:00:00.000Z',
        content: 'Private reasoning details',
      },
      call('one', 'read_file'),
      call('two', 'read_file'),
      call('three', 'read_file'),
      {
        id: 'usage-hidden',
        type: 'usage',
        timestamp: '2026-09-30T10:00:01.000Z',
        inputTokens: 7,
        outputTokens: 3,
      },
    ];
    render(<AgentTimeline events={events} />);
    expect(screen.queryByText(/read file calls/)).toBeNull();
    expect(screen.queryByText(/Private reasoning details/)).toBeNull();
    expect(screen.queryByText(/Step usage/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }));
    expect(screen.getByText(/3 read file calls/)).toBeTruthy();
    fireEvent.click(screen.getByText(/3 read file calls/));
    expect(screen.getAllByText('read file')).toHaveLength(3);
    expect(screen.getByText('Private reasoning details')).toBeTruthy();
    expect(screen.getByText(/Step usage/)).toBeTruthy();
  });

  it('shows the active command name in the collapsed running header', () => {
    render(
      <AgentTimeline
        events={[
          {
            id: 'running-status',
            type: 'status',
            timestamp: '2026-09-30T10:00:00.000Z',
            status: 'running',
          },
          {
            id: 'active-command',
            type: 'tool_use',
            timestamp: '2026-09-30T10:00:01.000Z',
            callId: 'command-1',
            tool: 'run_command',
            input: { command: 'pnpm test --filter ui' },
          },
        ]}
        startedAt="2026-09-30T10:00:00.000Z"
      />,
    );
    expect(screen.getByRole('button', { name: /Working.*command: pnpm/ })).toBeTruthy();
    expect(screen.queryByText('pnpm test --filter ui')).toBeNull();
  });
  it('shows the running tool title ahead of the plan step before streamed text arrives', () => {
    render(
      <AgentTimeline
        events={[
          {
            id: 'stale-completed-status',
            type: 'status',
            timestamp: '2026-09-30T10:00:00.000Z',
            status: 'completed',
          },
          call('active-tool', 'edit_file'),
        ]}
        startedAt="2026-09-30T10:00:00.000Z"
        isRunning
        runningToolTitle="Bound retry delay and add jitter"
        currentStep="Trace the retry policy"
      />,
    );
    expect(
      screen.getByRole('button', {
        name: /Working\.\.\. (?:\d+s|>1h) - Bound retry delay and add jitter/,
      }),
    ).toBeTruthy();
  });
  it('uses the active plan step when no tool call is running', () => {
    render(
      <AgentTimeline
        events={[
          {
            id: 'running-status',
            type: 'status',
            timestamp: '2026-09-30T10:00:00.000Z',
            status: 'running',
          },
        ]}
        startedAt="2026-09-30T10:00:00.000Z"
        currentStep="Trace the retry policy"
      />,
    );
    expect(
      screen.getByRole('button', { name: /Working\.\.\. (?:\d+s|>1h) - Trace the retry policy/ }),
    ).toBeTruthy();
  });
  it('keeps the reasoning-unavailable note inside the collapsed activity', () => {
    render(
      <AgentTimeline
        events={[
          {
            id: 'status-1',
            type: 'status',
            timestamp: '2026-09-30T10:00:00.000Z',
            status: 'running',
            reasoningAvailable: false,
          },
          {
            id: 'status-2',
            type: 'status',
            timestamp: '2026-09-30T10:00:01.000Z',
            status: 'running',
            reasoningAvailable: false,
          },
        ]}
      />,
    );
    assert.equal(screen.queryByText('This model doesn’t share its reasoning.'), null);
    fireEvent.click(screen.getByRole('button', { name: /Worked for|Working/ }));
    assert.equal(screen.getAllByText('This model doesn’t share its reasoning.').length, 1);
  });

  it('shows only the answer outside a collapsed activity chain', () => {
    render(
      <>
        <AgentTimeline
          events={[
            {
              id: 'answer',
              type: 'text',
              timestamp: '2026-09-30T10:00:00.000Z',
              content: 'answer text',
            },
            call('tool-1', 'run_command'),
            result('tool-1', 'command output'),
          ]}
        />
        <p>Visible answer</p>
      </>,
    );
    assert.ok(screen.getByText('Visible answer'));
    assert.equal(screen.queryByText('answer text'), null);
    assert.equal(screen.queryByText('command output'), null);
  });

  it('keeps resolved approval and handoff summaries inside the disclosure', () => {
    render(
      <AgentTimeline
        events={[]}
        activity={
          <>
            <p>Allowed: python routines/runner.py --list</p>
            <p>Switched to Llama 3.3 70B - rate limit on Qwen3.8 27B</p>
          </>
        }
      />,
    );
    assert.equal(screen.queryByText('Allowed: python routines/runner.py --list'), null);
    assert.equal(screen.queryByText(/Switched to Llama/), null);
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }));
    assert.ok(screen.getByText('Allowed: python routines/runner.py --list'));
    assert.ok(screen.getByText(/Switched to Llama/));
  });

  it('offers a full-output action with the recovery handle for truncated output', () => {
    const onShowFull = vi.fn();
    render(
      <AgentTimeline
        events={[call('tool-1', 'read_file'), result('tool-1', 'excerpt', true)]}
        onShowFull={onShowFull}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }));
    fireEvent.click(screen.getByRole('button', { name: /read file/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show full output' }));
    assert.equal(onShowFull.mock.calls[0]?.[0], 'recovery:test');
  });

  it.each(['acp', 'codex', 'claude', 'opencode'] as const)(
    'renders delegated %s fixture events as paired timeline steps',
    (source) => {
      const fixture = readFileSync(
        resolve(
          import.meta.dirname,
          '../../../../testkit/fixtures/agent-events',
          `${source}.jsonl`,
        ),
        'utf8',
      );
      const callId = /call-[a-z]+/.exec(fixture)?.[0];
      assert.ok(callId);
      const events: AgentEvent[] = [
        {
          id: `${source}-text`,
          type: 'text',
          timestamp: '2026-09-30T10:00:00.000Z',
          content: `${source} fixture answer`,
        },
        {
          id: `${source}-call`,
          type: 'tool_use',
          timestamp: '2026-09-30T10:00:01.000Z',
          callId,
          tool: 'read_file',
          input: {},
        },
        {
          id: `${source}-result`,
          type: 'tool_result',
          timestamp: '2026-09-30T10:00:02.000Z',
          callId,
          output: 'fixture output',
        },
      ];
      render(<AgentTimeline events={events} />);
      expect(screen.queryByText(`${source} fixture answer`)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Worked for/ }));
      fireEvent.click(screen.getByRole('button', { name: /read file/ }));
      expect(screen.getByText('fixture output')).toBeTruthy();
    },
  );
});
