import { describe, expect, it } from 'vitest';
import { runLiveProbe } from '../src/live-probe.js';
import { discoverProviderModels, parseCerebrasRateLimits } from '../src/index.js';

describe('live probe runner', () => {
  it('discovers only chat models and supplies metadata for models outside the catalog', async () => {
    const discovered = await discoverProviderModels('groq', 'fixture-key', {
      baseUrl: 'https://example.invalid/v1',
      fetch: () =>
        Promise.resolve(
          Response.json({
            data: [
              { id: 'qwen/qwen3.8-27b' },
              { id: 'whisper-large-v3' },
              { id: 'openai/gpt-oss-20b' },
            ],
          }),
        ),
    });
    expect(discovered.map((model) => model.ref)).toEqual([
      'groq/qwen/qwen3.8-27b',
      'groq/openai/gpt-oss-20b',
    ]);
    expect(discovered[0]).toMatchObject({ tier: 'T2', contextWindow: 131042, toolCalling: true });
    expect(discovered.find((model) => model.ref === 'groq/openai/gpt-oss-20b')?.toolCalling).toBe(
      true,
    );
    expect(discovered.find((model) => model.ref === 'groq/whisper-large-v3')).toBeUndefined();
  });

  it('sends conditional model-list validators and reuses the verified list on 304', async () => {
    let requestHeaders: Headers | undefined;
    let validator: string | null = null;
    const options = {
      baseUrl: 'https://example.invalid/v1',
      fetch: (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestHeaders = new Headers(init?.headers);
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }] }), {
            status: 200,
            headers: { etag: 'models-v1', 'content-type': 'application/json' },
          }),
        );
      },
      onResponse: (response: Response) => {
        validator = response.headers.get('etag');
      },
    };
    const models = await discoverProviderModels('groq', 'fixture-key', options);
    const refreshed = await discoverProviderModels('groq', 'fixture-key', {
      baseUrl: options.baseUrl,
      cachedModels: models,
      conditionalHeaders: { 'If-None-Match': 'models-v1' },
      fetch: (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    });
    expect(validator).toBe('models-v1');
    expect(requestHeaders?.get('if-none-match')).toBe('models-v1');
    expect(refreshed).toEqual(models);
  });

  it('uses explicit tool metadata and defaults unknown capability metadata to routable', async () => {
    const discovered = await discoverProviderModels('openrouter', 'fixture-key', {
      baseUrl: 'https://example.invalid/api/v1',
      fetch: () =>
        Promise.resolve(
          Response.json({
            data: [
              { id: 'vendor/verified:free', supported_parameters: ['tools'] },
              { id: 'vendor/no-tools:free', supported_parameters: ['temperature'] },
              { id: 'vendor/antigravity-preview:free' },
              { id: 'vendor/unlisted-coder:free' },
              {
                id: 'vendor/priced-model',
                supported_parameters: ['tools'],
                pricing: { prompt: '0.0000005', completion: '0.000001' },
              },
            ],
          }),
        ),
    });
    expect(discovered.map((model) => [model.ref, model.toolCalling])).toEqual([
      ['openrouter/vendor/verified:free', true],
      ['openrouter/vendor/no-tools:free', false],
      ['openrouter/vendor/antigravity-preview:free', true],
      ['openrouter/vendor/unlisted-coder:free', true],
      ['openrouter/vendor/priced-model', true],
    ]);
    expect(
      discovered.find((model) => model.ref === 'openrouter/vendor/unlisted-coder:free'),
    ).not.toHaveProperty('capability');
    expect(
      discovered.find((model) => model.ref === 'openrouter/vendor/priced-model'),
    ).toMatchObject({
      free: false,
      priceInPerM: 0.5,
      priceOutPerM: 1,
    });
  });

  it('uses the neutral tool assumption for discovered models without registry evidence', async () => {
    const discovered = await discoverProviderModels('gemini', 'fixture-key', {
      baseUrl: 'https://example.invalid/v1',
      fetch: () =>
        Promise.resolve(
          Response.json({
            data: [
              { id: 'antigravity-preview-05-2026' },
              { id: 'experimental-flash' },
              { id: 'gemini-3.8-flash' },
            ],
          }),
        ),
    });
    expect(discovered.map(({ ref, toolCalling }) => [ref, toolCalling])).toEqual([
      ['gemini/antigravity-preview-05-2026', true],
      ['gemini/experimental-flash', true],
      ['gemini/gemini-3.8-flash', true],
    ]);
  });

  it('normalizes NVIDIA model ids and does not treat its nano omni probe as tool verified', async () => {
    const discovered = await discoverProviderModels('nvidia', 'fixture-key', {
      baseUrl: 'https://example.invalid/v1',
      fetch: () =>
        Promise.resolve(
          Response.json({
            data: [
              { id: 'nvidia/nemotron-3-super-120b-a12b' },
              { id: 'nvidia/nemotron-3-nano-omni-unverified-reasoning' },
            ],
          }),
        ),
    });
    expect(discovered.map(({ ref, toolCalling }) => [ref, toolCalling])).toEqual([
      ['nvidia/nemotron-3-super-120b-a12b', true],
      ['nvidia/nemotron-3-nano-omni-unverified-reasoning', true],
    ]);
  });

  it('uses Ferry probing, redacts captured data, and reports OpenCode free-tier rejection', async () => {
    const key = 'fixture-secret-that-must-never-appear';
    const fixtures: unknown[] = [];
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url.endsWith('/models'))
        return Promise.resolve(Response.json({ data: [{ id: 'claude-haiku-4-5' }] }));
      return Promise.resolve(
        Response.json(
          {
            error: {
              message: "FreeTierError: OpenCode's free tier can only be used from within OpenCode",
            },
          },
          { status: 403 },
        ),
      );
    };
    const rows = await runLiveProbe({
      keys: { opencode: key },
      outputDirectory: 'unused',
      fetch,
      write: (_provider, fixture) =>
        Promise.resolve()
          .then(() => fixtures.push(fixture))
          .then(() => undefined),
    });
    expect(rows.find((row) => row.provider === 'opencode')).toMatchObject({
      provider: 'opencode',
      ok: false,
      errorKind: 'unsupported_free_tier',
      message: "Zen's free models only work inside OpenCode; Zen here needs paid balance",
    });
    expect(urls.some((url) => url.endsWith('/models'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/chat/completions'))).toBe(true);
    expect(JSON.stringify(fixtures)).not.toContain(key);
    expect(JSON.stringify(fixtures)).not.toContain('authorization');
  });

  it('runs fixture probes for every newly cataloged compatible provider', async () => {
    const catalogProviders = [
      'sambanova',
      'llm7',
      'cloudflare-workers-ai',
      'kilo',
      'vercel-ai-gateway',
      'huggingface',
      'ovhcloud',
      'tokenrouter',
      'anyapi',
      'zai-glm',
      'fireworks',
      'nebius',
      'scaleway',
      'hyperbolic',
      'deepinfra',
      'novita',
      'together',
      'stepfun',
    ];
    const keys = Object.fromEntries(catalogProviders.map((provider) => [provider, 'fixture-key']));
    const fetch: typeof globalThis.fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/models'))
        return Promise.resolve(Response.json({ data: [{ id: 'fixture-model' }] }));
      return Promise.resolve(
        Response.json({
          id: 'chatcmpl_fixture',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    };
    const rows = await runLiveProbe({
      keys,
      outputDirectory: 'unused',
      fetch,
      baseUrls: { 'cloudflare-workers-ai': 'https://fixture.invalid/v1' },
      write: () => Promise.resolve(),
    });
    expect(rows).toHaveLength(catalogProviders.length);
    expect(rows.every((row) => row.ok)).toBe(true);
  });

  it('probes anonymous Kilo and OVHcloud endpoints without authorization headers', async () => {
    const authorizationByHost = new Map<string, string | null>();
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const host = new URL(url).hostname;
      if (host === 'ovh.net' || host.endsWith('cloud.ovh.net') || host === 'api.kilo.ai')
        authorizationByHost.set(
          host,
          new Headers(input instanceof Request ? input.headers : init?.headers).get(
            'authorization',
          ),
        );
      if (url.endsWith('/models')) return Promise.resolve(Response.json({ data: [] }));
      return Promise.resolve(
        Response.json({
          id: 'chatcmpl_fixture',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    };
    const rows = await runLiveProbe({
      keys: {},
      outputDirectory: 'unused',
      fetch,
      write: () => Promise.resolve(),
    });
    expect(rows.find((row) => row.provider === 'ovhcloud')?.ok).toBe(true);
    expect(rows.find((row) => row.provider === 'kilo')?.ok).toBe(true);
    expect(authorizationByHost.get('oai.endpoints.kepler.ai.cloud.ovh.net')).toBeNull();
    expect(authorizationByHost.get('api.kilo.ai')).toBeNull();
  });

  it('clamps rate-limit remaining values to the reported limit', () => {
    const windows = parseCerebrasRateLimits({
      'x-ratelimit-limit-tokens-hour': '1000000',
      'x-ratelimit-remaining-tokens-hour': '2999930',
    });
    expect(windows.find((window) => window.windowId === 'tokens-hour')).toMatchObject({
      limit: 1000000,
      remaining: 1000000,
      confidence: 'exact',
    });
  });
});
