import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  anthropicToCanonical,
  canonicalStreamEventsToAnthropic,
  canonicalStreamEventsToGemini,
  canonicalStreamEventsToOpenAiChat,
  canonicalStreamEventsToResponses,
  canonicalToGatewayMessages,
  finalizeCanonicalStream,
  geminiToCanonical,
  openAiChatToCanonical,
  openAiResponsesToCanonical,
} from '../src/canonical.js';

const golden = JSON.parse(
  await readFile(new URL('./fixtures/canonical-golden.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('canonical protocol conversions', () => {
  it('preserves OpenAI reasoning efforts through chat and Responses normalization', () => {
    expect(
      openAiChatToCanonical({ model: 'openai/gpt-5', messages: [], reasoning_effort: 'low' })
        .effort,
    ).toBe('low');
    expect(
      openAiChatToCanonical({ model: 'openai/gpt-5', messages: [], reasoning: { effort: 'high' } })
        .effort,
    ).toBe('high');
    expect(
      openAiResponsesToCanonical({
        model: 'openai/gpt-5',
        input: 'hello',
        reasoning: { effort: 'xhigh' },
      }).effort,
    ).toBe('xhigh');
    expect(
      openAiChatToCanonical({ model: 'custom/model', messages: [], reasoning_effort: 'invalid' })
        .effort,
    ).toBeUndefined();
  });
  it('normalizes OpenAI Chat, Anthropic Messages, Responses, and Gemini requests', () => {
    const chat = openAiChatToCanonical(golden.chat as Record<string, unknown>);
    const anthropic = anthropicToCanonical(golden.anthropic as Record<string, unknown>);
    const responses = openAiResponsesToCanonical(golden.responses as Record<string, unknown>);
    const gemini = geminiToCanonical(golden.gemini as Record<string, unknown>, 'ferry/auto-free');
    expect(chat.messages[0]?.parts).toEqual([{ type: 'text', text: 'hello' }]);
    expect(anthropic.messages.find((item) => item.role === 'assistant')?.toolCalls).toEqual([
      { id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
    ]);
    expect(responses.tools?.[0]?.name).toBe('lookup');
    expect(gemini.messages[0]?.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('round trips Responses function calls into the runtime tool-call contract', () => {
    const request = openAiResponsesToCanonical({
      model: 'ferry/best',
      input: [{ type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{"q":"x"}' }],
    });
    expect(canonicalToGatewayMessages(request.messages).messages[0]?.tool_calls?.[0]).toMatchObject(
      {
        id: 'call_9',
        function: { name: 'lookup', arguments: '{"q":"x"}' },
      },
    );
  });

  it('normalizes Codex Responses reasoning, function calls, and tool results', () => {
    const request = openAiResponsesToCanonical(golden.codexResponses as Record<string, unknown>);
    expect(request.stream).toBe(true);
    expect(request.messages.map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'tool',
    ]);
    expect(request.messages[1]?.parts).toEqual([
      { type: 'reasoning', text: 'Need inspect before editing.' },
    ]);
    expect(canonicalToGatewayMessages(request.messages).messages).toMatchObject([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: '# Ferry' },
    ]);
  });

  it('rejects unsupported Responses chaining and flushes terminal usage on finalization', () => {
    expect(() =>
      openAiResponsesToCanonical({ model: 'ferry/best', previous_response_id: 'resp_1' }),
    ).toThrow('previous_response_id is not supported');
    const final = finalizeCanonicalStream([{ type: 'text_delta', text: 'hello' }], 'stop', {
      inputTokens: 2,
      cachedTokens: 1,
      outputTokens: 1,
    });
    expect(final.events.at(-1)).toEqual({
      type: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 2, cachedTokens: 1, outputTokens: 1 },
    });
    expect(canonicalStreamEventsToResponses(final.events, 'resp_test').at(-1)).toMatchObject({
      type: 'response.completed',
      usage: { input_tokens_details: { cached_tokens: 1 } },
    });
    expect(canonicalStreamEventsToGemini(final.events).at(-1)).toMatchObject({
      usageMetadata: { totalTokenCount: 3, cachedContentTokenCount: 1 },
    });
    expect(canonicalStreamEventsToOpenAiChat(final.events).at(-1)).toMatchObject({
      usage: { total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
    });
    expect(canonicalStreamEventsToAnthropic(final.events).at(-1)).toEqual({
      type: 'message_stop',
    });
  });
});
