import { describe, expect, it } from 'vitest';
import {
  normalizeOpenRouterResponse,
  normalizeOpenRouterUsage,
} from '../src/openrouter-response.js';

describe('OpenRouter usage compatibility', () => {
  it('derives a missing total without counting reasoning tokens twice or mutating the payload', () => {
    const payload = {
      choices: [],
      usage: {
        prompt_tokens: 1108,
        completion_tokens: 93,
        completion_tokens_details: { reasoning_tokens: 58 },
      },
    };
    expect(normalizeOpenRouterUsage(payload)).toEqual({
      ...payload,
      usage: { ...payload.usage, total_tokens: 1201 },
    });
    expect(payload.usage).not.toHaveProperty('total_tokens');
  });

  it('preserves explicit totals and leaves incomplete or invalid counts for SDK validation', () => {
    for (const usage of [
      { prompt_tokens: 2, completion_tokens: 3, total_tokens: 9 },
      { prompt_tokens: 2 },
      { prompt_tokens: -1, completion_tokens: 3 },
      { prompt_tokens: '2', completion_tokens: 3 },
      { prompt_tokens: NaN, completion_tokens: 3 },
      { prompt_tokens: Number.MAX_VALUE, completion_tokens: Number.MAX_VALUE },
    ]) {
      const payload = { usage };
      expect(normalizeOpenRouterUsage(payload)).toBe(payload);
    }
  });

  it('handles split UTF-8, CRLF, usage-only data, comments, DONE and a final unterminated line', async () => {
    const text =
      ': keepalive\r\ndata: {"choices":[{"delta":{"content":"café"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\ndata: malformed';
    const bytes = new TextEncoder().encode(text);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'content-length': String(bytes.length),
          'x-test': 'preserved',
        },
      },
    );
    const normalized = normalizeOpenRouterResponse(response);
    expect(normalized.headers.get('x-test')).toBe('preserved');
    expect(normalized.headers.has('content-length')).toBe(false);
    expect(await normalized.text()).toBe(
      text.replace('"completion_tokens":3}', '"completion_tokens":3,"total_tokens":5}'),
    );
  });

  it('forwards deltas before the response ends and propagates cancellation', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const body = normalizeOpenRouterResponse(response).body as ReadableStream<Uint8Array> | null;
    const reader = body?.getReader();
    if (!reader || !source) throw new Error('Missing stream');
    source.enqueue(
      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'),
    );
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('hello');
    await reader.cancel();
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(cancelled).toBe(true);
  });

  it('passes through provider failures and non-streaming responses', () => {
    const error = new Response('failure', {
      status: 400,
      headers: { 'content-type': 'text/event-stream' },
    });
    const json = Response.json({ usage: { prompt_tokens: 2, completion_tokens: 3 } });
    expect(normalizeOpenRouterResponse(error)).toBe(error);
    expect(normalizeOpenRouterResponse(json)).toBe(json);
  });
});
