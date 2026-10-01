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

  it('keeps thinking collapsed until expanded and shows its character and token counts', () => {
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
    assert.ok(screen.getByText('28 chars · ~7 tokens'));
    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  });

  it('shows one reasoning-unavailable note for the turn', () => {
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
    assert.equal(screen.getAllByText('This model doesn’t share its reasoning.').length, 1);
  });

  it('offers a full-output action with the recovery handle for truncated output', () => {
    const onShowFull = vi.fn();
    render(
      <AgentTimeline
        events={[call('tool-1', 'read_file'), result('tool-1', 'excerpt', true)]}
        onShowFull={onShowFull}
      />,
    );
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
      expect(screen.getByText(`${source} fixture answer`)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /read file/ }));
      expect(screen.getByText('fixture output')).toBeTruthy();
    },
  );
});
