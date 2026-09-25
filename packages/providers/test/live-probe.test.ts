import { describe, expect, it } from 'vitest';
import { runLiveProbe } from '../src/live-probe.js';
import { discoverProviderModels } from '../src/index.js';

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
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
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
});
