import { describe, expect, it, vi } from 'vitest';
import { ModelInfoSchema } from '@ferry/shared';
import { MemorySecretStore } from '@ferry/secrets';

const mock = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
  createModels: () => ({
    setProvider: () => undefined,
    getModel: () => ({
      provider: 'openai-codex',
      id: 'thinker',
      api: 'openai-codex-responses',
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: null,
        max: null,
      },
    }),
    streamSimple: mock.stream,
  }),
}));
import { oauthModelCatalog, streamOAuthStep } from '../src/index.js';

describe('OAuth reasoning effort and usage', () => {
  it('derives effort availability from pi-ai model thinking maps', () => {
    const models = oauthModelCatalog.filter((model) => model.providerId === 'openai-codex');
    expect(models.some((model) => model.reasoningEfforts?.includes('high'))).toBe(true);
    expect(models.every((model) => model.reasoningEfforts !== undefined)).toBe(true);
  });
  it.each(['high', 'xhigh', null] as const)(
    'passes %s only when both Ferry and pi-ai advertise it',
    async (effort) => {
      mock.stream.mockClear();
      mock.stream.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield await Promise.resolve({ type: 'thinking_delta', delta: 'Thinking' });
          yield await Promise.resolve({ type: 'text_delta', delta: 'Done' });
        },
        result: () =>
          Promise.resolve({
            content: [],
            usage: { input: 10, output: 12, reasoning: 7 },
            stopReason: 'stop',
          }),
      });
      const model = ModelInfoSchema.parse({
        providerId: 'openai-codex',
        ref: 'openai-codex/thinker',
        name: 'Thinker',
        tier: 'T1',
        contextWindow: 128_000,
        maxOutput: 32_000,
        reasoning: true,
        reasoningEfforts: ['high', 'xhigh'],
        toolCalling: true,
        free: false,
        priceInPerM: null,
        priceOutPerM: null,
      });
      const onReasoning = vi.fn();
      const result = await streamOAuthStep(new MemorySecretStore(), {
        model,
        effort,
        system: 'test',
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        onDelta: () => undefined,
        onReasoning,
      });
      const options = mock.stream.mock.calls[0]?.[2] as Record<string, unknown>;
      if (effort === 'high') expect(options.reasoning).toBe('high');
      else expect(options).not.toHaveProperty('reasoning');
      expect(result.reasoningTokens).toBe(7);
      expect(result.thinkingDurationMs).toBeGreaterThanOrEqual(0);
      expect(onReasoning).toHaveBeenCalledWith('Thinking');
    },
  );
});
