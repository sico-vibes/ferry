import { expect, it } from 'vitest';
import { discoverProviderModels, probe } from '../src/index.js';

it('discovers local context and advertised tools without inventing unknown tool support', async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, authorization: request.headers.get('authorization') });
    return Promise.resolve(
      Response.json({
        data: [
          { id: 'local-coder', context_length: 32768, supported_parameters: ['tools'] },
          { id: 'text-only', context_length: 4096 },
        ],
      }),
    );
  };
  const models = await discoverProviderModels('ollama', '', {
    baseUrl: 'http://localhost:11434/v1',
    fetch,
  });
  expect(models[0]).toMatchObject({
    contextWindow: 32768,
    toolCalling: true,
    free: true,
    priceInPerM: 0,
  });
  expect(models[1]).toMatchObject({ toolCalling: false, free: true });
  expect(calls[0]?.authorization).toBeNull();
  await discoverProviderModels('lmstudio', 'fixture-local-token', {
    baseUrl: 'http://localhost:1234/v1',
    fetch,
  });
  expect(calls[1]?.authorization).toBe('Bearer fixture-local-token');
});
it('discovers custom API models at the configured endpoint and retains unknown paid prices', async () => {
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe('http://localhost:8080/v1/models');
    expect(request.headers.get('authorization')).toBe('Bearer fixture-custom-token');
    return Promise.resolve(
      Response.json({ data: [{ id: 'custom-coder', supported_parameters: ['tools'] }] }),
    );
  };
  const models = await discoverProviderModels('openai-compatible', 'fixture-custom-token', {
    baseUrl: 'http://localhost:8080/v1',
    fetch,
  });
  expect(models[0]).toMatchObject({
    ref: 'openai-compatible/custom-coder',
    toolCalling: true,
    free: false,
    priceInPerM: null,
    priceOutPerM: null,
  });
});
it('checks a paid connection through model discovery without synthetic generation', async () => {
  const calls: string[] = [];
  const result = await probe('openai', 'fixture-token', {
    discoveryOnly: true,
    baseUrl: 'http://localhost:8080/v1',
    fetch: (input, init) => {
      calls.push(new Request(input, init).url);
      return Promise.resolve(Response.json({ data: [{ id: 'paid-model' }] }));
    },
  });
  expect(result).toMatchObject({ ok: true, usedModel: null });
  expect(result.message).toContain('generation is untested');
  expect(calls).toEqual(['http://localhost:8080/v1/models']);
});
