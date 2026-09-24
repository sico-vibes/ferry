import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@ferry/shared';
import { groupParts } from './index';

const tool = (id: string, toolName = 'read_file', status = 'succeeded') =>
  ({
    id,
    type: 'tool_call',
    tool: toolName,
    title: id,
    args: {},
    status,
    output: null,
    changes: [],
    durationMs: 100,
  }) as unknown as MessagePart;

describe('groupParts', () => {
  it('groups consecutive tool calls and preserves their order', () => {
    const parts = [
      tool('a'),
      tool('b', 'grep'),
      { id: 'c', type: 'text', text: 'done' } as MessagePart,
    ];
    expect(groupParts(parts)).toEqual([
      { type: 'tool_group', parts: [parts[0], parts[1]] },
      parts[2],
    ]);
  });

  it('returns an empty list for an empty message', () => {
    expect(groupParts([])).toEqual([]);
  });

  it('groups a trailing run of tools and keeps a lone tool ungrouped', () => {
    const parts = [tool('only'), tool('a'), tool('b', 'grep'), tool('c', 'edit_file')];
    expect(groupParts(parts)).toEqual([
      parts[0],
      { type: 'tool_group', parts: [parts[1], parts[2], parts[3]] },
    ]);
  });

  it('keeps isolated tools and does not group across an approval boundary', () => {
    const approval = {
      id: 'approval',
      type: 'approval_request',
      kind: 'command',
      summary: 'Run',
      detail: 'npm test',
      risk: 'low',
      state: 'pending',
    } as MessagePart;
    expect(groupParts([tool('one'), approval, tool('two')])).toEqual([
      tool('one'),
      approval,
      tool('two'),
    ]);
  });
});
