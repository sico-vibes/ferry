// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@ferry/shared';
import { ActivityRow, activityDiff, summarizeActivity } from './ActivityRow';

type ToolPart = Extract<MessagePart, { type: 'tool_call' }>;
let sequence = 0;
const tool = (
  name: string,
  overrides: Partial<ToolPart> = {},
  path = `src/file-${String(sequence)}.ts`,
): ToolPart =>
  ({
    type: 'tool_call',
    id: `part_${String(++sequence)}`,
    tool: name,
    title: `Step ${String(sequence)}`,
    args: { path },
    status: 'succeeded',
    output: null,
    changes: [],
    durationMs: 10,
    ...overrides,
  }) as ToolPart;

describe('summarizeActivity', () => {
  it('reads like a sentence with correct plurals', () => {
    expect(
      summarizeActivity([
        tool('read_file'),
        tool('read_file'),
        tool('grep'),
        tool('run_command'),
        tool('run_command'),
      ]),
    ).toBe('Searched code, read 2 files, ran 2 commands');
    expect(summarizeActivity([tool('read_file')])).toBe('Read 1 file');
    expect(summarizeActivity([tool('update_plan')])).toBe('Updated the plan');
  });

  it('counts distinct edited files and separates new files from edits', () => {
    const edit = (path: string, deletions: number) =>
      tool(
        'edit_file',
        { changes: [{ path, additions: 3, deletions }] } as Partial<ToolPart>,
        path,
      );
    expect(summarizeActivity([edit('a.ts', 1), edit('a.ts', 2), edit('b.ts', 0)])).toBe(
      'Edited 2 files',
    );
    const created = tool(
      'write_file',
      { changes: [{ path: 'blog.html', additions: 82, deletions: 0 }] } as Partial<ToolPart>,
      'blog.html',
    );
    expect(summarizeActivity([created])).toBe('Created 1 file');
    expect(activityDiff([created, edit('a.ts', 4)])).toEqual({ additions: 85, deletions: 4 });
  });
});

describe('ActivityRow', () => {
  it('shows the running step in the present tense and expands to the steps', () => {
    const parts = [
      tool('read_file'),
      tool('run_command', { status: 'running', title: 'Run pnpm test' }),
    ];
    render(<ActivityRow parts={parts} renderSteps={() => <p>step list</p>} />);
    const toggle = screen.getByRole('button', { name: /Run pnpm test…/ });
    expect(screen.queryByText('step list')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('step list')).toBeTruthy();
  });

  it('opens automatically when a step failed', () => {
    render(
      <ActivityRow
        parts={[tool('run_command', { status: 'failed' })]}
        renderSteps={() => <p>details</p>}
      />,
    );
    expect(screen.getByText('1 step failed')).toBeTruthy();
    expect(screen.getByText('details')).toBeTruthy();
  });
});
