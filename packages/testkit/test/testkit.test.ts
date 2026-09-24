import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeAnthropicServer,
  FakeGeminiServer,
  FakeOpenAIServer,
  FakeOpenRouterKeyEndpoint,
  FakeClock,
  createFixtureRepo,
  recordedCliEvents,
} from '../src/index.js';

const servers: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});
async function fetchFrom<
  T extends {
    start: () => Promise<T>;
    baseUrl: string;
    requests: unknown[];
    stop: () => Promise<void>;
  },
>(server: T, path: string, body?: unknown) {
  await server.start();
  servers.push(server);
  return fetch(
    `${server.baseUrl}${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
}
describe('testkit fakes', () => {
  it('serves OpenAI request, tool-call, usage, and response-header contracts', async () => {
    const server = new FakeOpenAIServer({
      responseHeaders: {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '29',
        'retry-after': '1',
      },
    });
    const response = await fetchFrom(server, '/v1/chat/completions', {
      model: 'fake',
      stream: false,
    });
    const data = (await response.json()) as {
      choices: { message: { tool_calls: unknown[] } }[];
      usage: { total_tokens: number };
    };
    expect(data.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(data.usage.total_tokens).toBe(20);
    expect(response.headers.get('x-ratelimit-remaining-requests')).toBe('29');
    expect(server.requests).toHaveLength(1);
  });
  it('serves Anthropic tool_use and Gemini quota RetryInfo', async () => {
    const anthropic = new FakeAnthropicServer();
    expect(await (await fetchFrom(anthropic, '/v1/messages', {})).json()).toMatchObject({
      content: [{ type: 'tool_use' }],
    });
    const gemini = FakeGeminiServer.rateLimited(17, 'flash_requests');
    const limited = (await (
      await fetchFrom(gemini, '/models/flash:generateContent', {})
    ).json()) as {
      error: {
        status: string;
        details: { retryDelay?: string; violations?: { quotaMetric: string }[] }[];
      };
    };
    expect(limited.error.status).toBe('RESOURCE_EXHAUSTED');
    expect(limited.error.details[0]?.retryDelay).toBe('17s');
    expect(limited.error.details[1]?.violations?.[0]?.quotaMetric).toBe('flash_requests');
  });
  it('serves OpenRouter key quotas, builds git fixtures, and provides stable clocks and CLI events', async () => {
    const key = new FakeOpenRouterKeyEndpoint();
    expect(await (await fetchFrom(key, '/api/v1/key')).json()).toMatchObject({
      data: { free_model_daily_requests: { remaining: 42, limit: 50 } },
    });
    const repo = await createFixtureRepo('crlf');
    try {
      expect(repo.path).toContain('ferry-fixture-');
    } finally {
      await repo.cleanup();
    }
    const clock = new FakeClock(100);
    clock.advance(25);
    expect(clock.now()).toBe(125);
    expect(
      recordedCliEvents('claude').some((event) => (event as { type?: string }).type === 'result'),
    ).toBe(true);
  });
});
