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
    const toggle = screen.getByRole('button', { name: /Reviewing the changed files/ });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(screen.queryByText('28 chars · ~7 tokens'), null);
    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('28 chars · ~7 tokens'));
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
