/* eslint
  @typescript-eslint/no-non-null-assertion: off,
  @typescript-eslint/require-await: off
*/
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  normalizeToolSchema,
  promptCacheOptions,
  sanitizeProviderMessages,
} from '../src/normalization.js';

function rawContent(message: ModelMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function firstToolId(messages: readonly ModelMessage[]): string {
  const content = messages[0]?.content as unknown as { toolCallId?: string }[] | undefined;
  return content?.[0]?.toolCallId ?? '';
}

function firstToolOutput(messages: readonly ModelMessage[]): string {
  const content = messages[0]?.content as unknown as { output?: { value?: string } }[] | undefined;
  return content?.[0]?.output?.value ?? '';
}

describe('QA weak providers: surrogate and empty-part sanitizing', () => {
  it('replaces lone surrogates and preserves valid astral pairs', () => {
    const loneHigh = 'a' + String.fromCharCode(0xd800) + 'b';
    const loneLow = 'a' + String.fromCharCode(0xdc00) + 'b';
    const pair = 'a' + String.fromCharCode(0xd83c, 0xdf89) + 'b';
    const result = sanitizeProviderMessages(
      [
        { role: 'user', content: loneHigh },
        { role: 'user', content: loneLow },
        { role: 'user', content: pair },
      ],
      'openai',
    );
    expect(result.map(rawContent)).toEqual(['a\uFFFDb', 'a\uFFFDb', pair]);
  });

  it('drops empty and whitespace-only text/reasoning parts', () => {
    expect(
      sanitizeProviderMessages(
        [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '' },
              { type: 'reasoning', text: '   ' },
              { type: 'text', text: 'kept' },
            ],
          },
        ],
        'openai',
      ),
    ).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'kept' }] }]);
  });

  it('scrubs tool ids per provider and leaves other providers untouched', () => {
    const build = (toolCallId: string): ModelMessage[] => [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: 't',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
    ];
    const id = 'bad/id with spaces';
    expect(firstToolId(sanitizeProviderMessages(build(id), 'mistral'))).toBe('badidwith');
    expect(firstToolId(sanitizeProviderMessages(build(id), 'anthropic'))).toBe(
      'bad_id_with_spaces',
    );
    expect(firstToolId(sanitizeProviderMessages(build(id), 'openai'))).toBe(id);
  });

  it('inserts exactly one Mistral tool→user bridge and maps DeepSeek reasoning', () => {
    const result = sanitizeProviderMessages(
      [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'a',
              toolName: 't',
              output: { type: 'text', value: '1' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'b',
              toolName: 't',
              output: { type: 'text', value: '2' },
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
      'mistral',
    );
    expect(result.filter((message) => message.role === 'assistant')).toEqual([
      { role: 'assistant', content: 'Done.' },
    ]);
    expect(
      sanitizeProviderMessages(
        [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] }],
        'deepseek',
      ),
    ).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'thinking' }] }]);
  });
});

describe('QA weak providers: tool schema normalization', () => {
  const samples: unknown[] = [
    { type: 'string' },
    { oneOf: [{ const: 'a' }, { const: 'b' }] },
    { anyOf: [{ properties: { k: { const: 'x' } } }, { properties: { k: { const: 'y' } } }] },
    {
      $defs: { X: { type: 'number' } },
      properties: { x: { $ref: '#/$defs/X' } },
      additionalProperties: false,
    },
    { type: 'object', properties: { a: { enum: ['a', 'b'], description: 'd' } }, $schema: 'x' },
  ];

  it('is idempotent across representative schemas', () => {
    for (const sample of samples) {
      const once = normalizeToolSchema(sample, 'openai');
      expect(normalizeToolSchema(once, 'openai')).toEqual(once);
      expect(normalizeToolSchema(normalizeToolSchema(sample, 'generic'), 'generic')).toEqual(
        normalizeToolSchema(sample, 'generic'),
      );
    }
  });

  it('folds oneOf string const unions to enum and strips per-provider keywords', () => {
    expect(
      normalizeToolSchema(
        {
          $defs: { x: {} },
          oneOf: [
            { properties: { type: { const: 'a' } } },
            { properties: { type: { const: 'b' } } },
          ],
          additionalProperties: false,
        },
        'openai',
      ),
    ).toEqual({ enum: ['a', 'b'] });
    expect(
      normalizeToolSchema(
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
        'generic',
      ),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('only enables prompt caching for providers that support it', () => {
    expect(promptCacheOptions('anthropic', true, 'session')).toEqual({
      cache_control: { type: 'ephemeral' },
    });
    expect(promptCacheOptions('openai', true, 'session')).toEqual({
      prompt_cache_key: 'session',
    });
    expect(promptCacheOptions('mistral', true, 'session')).toEqual({});
    expect(promptCacheOptions('openai', false, 'session')).toEqual({});
  });

  it('does not leave dangling $refs after dropping $defs', () => {
    // BUG: normalizeToolSchema deletes $defs/definitions unconditionally but keeps
    // $ref pointers, so a referenced schema becomes invalid for strict validators.
    const normalized = normalizeToolSchema(
      {
        type: 'object',
        properties: { a: { $ref: '#/$defs/Foo' } },
        required: ['a'],
        $defs: { Foo: { type: 'string' } },
      },
      'openai',
    ) as Record<string, unknown>;
    const properties = normalized.properties as Record<string, unknown>;
    const ref = (properties.a as { $ref?: string }).$ref;
    expect(ref === undefined || normalized.$defs !== undefined).toBe(true);
  });

  it('sanitizes lone surrogates inside tool-result output values', () => {
    // BUG: only part.text and part.toolCallId are cleaned; nested tool-result
    // output.value strings keep lone surrogates and still reach the provider.
    const bad = 'a' + String.fromCharCode(0xd800) + 'b';
    const result = sanitizeProviderMessages(
      [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'ok',
              toolName: 't',
              output: { type: 'text', value: bad },
            },
          ],
        },
      ],
      'openai',
    );
    expect(firstToolOutput(result)).not.toContain('\ud800');
  });

  it('keeps distinct long Mistral tool ids distinct', () => {
    // BUG: Mistral ids are truncated to nine characters, so two ids sharing a
    // nine-character prefix collide and tool results can be matched to the wrong
    // call.
    const build = (toolCallId: string): ModelMessage[] => [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: 't',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
    ];
    const first = firstToolId(sanitizeProviderMessages(build('call-abcdefghij-1'), 'mistral'));
    const second = firstToolId(sanitizeProviderMessages(build('call-abcdefghij-2'), 'mistral'));
    expect(first).not.toBe(second);
  });
});
