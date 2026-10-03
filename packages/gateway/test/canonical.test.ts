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
  it('normalizes OpenAI Chat, Anthropic Messages, Responses, and Gemini requests', () => {
    const chat = openAiChatToCanonical(golden.chat as Record<string, unknown>);
    const anthropic = anthropicToCanonical(golden.anthropic as Record<string, unknown>);
    const responses = openAiResponsesToCanonical(golden.responses as Record<string, unknown>);
    const gemini = geminiToCanonical(golden.gemini as Record<string, unknown>, 'ferry/auto-free');
    expect(chat.messages[0]?.parts).toEqual([{ type: 'text', text: 'hello' }]);
    expect(anthropic.messages[0]?.toolCalls).toEqual([
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

  it('rejects unsupported Responses chaining and flushes terminal usage on finalization', () => {
    expect(() =>
      openAiResponsesToCanonical({ model: 'ferry/best', previous_response_id: 'resp_1' }),
    ).toThrow('previous_response_id is not supported');
    const final = finalizeCanonicalStream([{ type: 'text_delta', text: 'hello' }], 'stop', {
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(final.events.at(-1)).toEqual({
      type: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(canonicalStreamEventsToResponses(final.events, 'resp_test').at(-1)).toMatchObject({
      type: 'response.completed',
    });
    expect(canonicalStreamEventsToGemini(final.events).at(-1)).toMatchObject({
      usageMetadata: { totalTokenCount: 3 },
    });
    expect(canonicalStreamEventsToOpenAiChat(final.events).at(-1)).toMatchObject({
      usage: { total_tokens: 3 },
    });
    expect(canonicalStreamEventsToAnthropic(final.events).at(-1)).toEqual({
      type: 'message_stop',
    });
  });
});
