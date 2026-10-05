import { describe, expect, it } from 'vitest';
import { gatewaySnippets } from './snippets';

describe('gateway setup snippets', () => {
  const snippets = gatewaySnippets('http://127.0.0.1:11435');

  it('points OpenAI-compatible tools at /v1 and Anthropic tools at the root', () => {
    const byId = Object.fromEntries(snippets.map((snippet) => [snippet.id, snippet.code]));
    expect(byId.opencode).toContain('"baseURL": "http://127.0.0.1:11435/v1"');
    expect(byId.codex).toContain('base_url = "http://127.0.0.1:11435/v1"');
    expect(byId.curl).toContain('http://127.0.0.1:11435/v1/chat/completions');
    expect(byId['claude-code']).toContain("ANTHROPIC_BASE_URL = 'http://127.0.0.1:11435'");
  });

  it('never embeds a real key, only the placeholder', () => {
    for (const snippet of snippets) expect(snippet.code).not.toMatch(/ferry-gw-|sk-/);
    expect(
      snippets.every(
        (snippet) => snippet.code.includes('YOUR_FERRY_KEY') || snippet.id === 'codex',
      ),
    ).toBe(true);
  });

  it('produces valid JSON for OpenCode', () => {
    const opencode = snippets.find((snippet) => snippet.id === 'opencode');
    const parse = (): unknown => JSON.parse(opencode?.code ?? '');
    expect(parse).not.toThrow();
  });
});
