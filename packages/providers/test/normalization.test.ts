import { describe, expect, it } from 'vitest';
import {
  sanitizeProviderMessages,
  normalizeToolSchema,
  promptCacheOptions,
} from '../src/normalization.js';
describe('provider request normalization', () => {
  it('drops empty content and sanitizes surrogate code units', () => {
    const messages = sanitizeProviderMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'a' + String.fromCharCode(0xd800) + 'b' },
          ],
        },
      ],
      'openai',
    );
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a\uFFFDb' }] }]);
  });
  it('drops reasoning from Groq assistant history but keeps the tool call', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'reasoning' as const, text: 'Listing the folder first.' },
          { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'list_dir', input: {} },
        ],
      },
    ];
    expect(sanitizeProviderMessages(history, 'groq')).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'list_dir', input: {} }],
      },
    ]);
    expect(JSON.stringify(sanitizeProviderMessages(history, 'openai'))).toContain('Listing');
  });
  it('adds Mistral assistant bridge and stable tool identifiers', () => {
    const messages = sanitizeProviderMessages(
      [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'bad/id',
              toolName: 'x',
              output: { type: 'text', value: 'ok' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'next turn',
            },
          ],
        },
      ],
      'mistral',
    );
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Done.' });
    expect(JSON.stringify(messages)).toContain('badid0000');
  });
  it('normalizes schemas and caches only supported providers', () => {
    expect(
      normalizeToolSchema(
        {
          $defs: { x: {} },
          oneOf: [
            { properties: { type: { const: 'a' } } },
            { properties: { type: { const: 'b' } } },
          ],
        },
        'openai',
      ),
    ).toEqual({ enum: ['a', 'b'] });
    expect(promptCacheOptions('anthropic', true, 'session')).toEqual({
      cache_control: { type: 'ephemeral' },
    });
    expect(promptCacheOptions('mistral', true, 'session')).toEqual({});
  });
  it('converts unsupported DeepSeek reasoning parts into text', () => {
    expect(
      sanitizeProviderMessages(
        [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] }],
        'deepseek',
      ),
    ).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'thinking' }] }]);
  });
});
