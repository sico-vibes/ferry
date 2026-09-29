import { describe, expect, it } from 'vitest';
import { toGatewayModelMessages } from '../src/gateway.js';

describe('gateway provider prompt conversion', () => {
  it('preserves empty assistant tool-call turns and their matching tool results', () => {
    const messages = toGatewayModelMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_1',
        name: 'read_file',
        content: 'README contents',
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_read_1',
            toolName: 'read_file',
            input: { path: 'README.md' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_read_1',
            toolName: 'read_file',
            output: { type: 'text', value: 'README contents' },
          },
        ],
      },
    ]);
  });

  it('keeps ordinary user and assistant text while excluding system instructions', () => {
    const messages = toGatewayModelMessages([
      { role: 'system', content: 'system prompt' },
      { role: 'developer', content: 'developer prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });
});
