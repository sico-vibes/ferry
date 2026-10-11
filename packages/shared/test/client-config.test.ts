import { describe, expect, it } from 'vitest';
import {
  configuredContent,
  curlSnippet,
  toolLaunch,
  openAiConfig,
  nativeOpenCodeLaunch,
} from '../src/client-config.js';

const connection = { url: 'http://127.0.0.1:11435', secret: 'YOUR_FERRY_KEY', model: 'ferry/auto' };
describe('shared client configuration', () => {
  it('launches the actual OpenCode app without Ferry credentials or provider overrides', () => {
    expect(nativeOpenCodeLaunch('opencode/big-pickle', ["D:/Basem's/project"])).toEqual({
      command: 'opencode',
      args: ['--model', 'opencode/big-pickle', "D:/Basem's/project"],
      env: {},
    });
  });
  it('generates generic OpenAI configuration', () => {
    expect(openAiConfig(connection)).toMatchSnapshot();
  });
  for (const client of ['opencode', 'codex', 'claude'] as const) {
    it(`generates ${client} configuration and launch settings`, () => {
      expect(configuredContent(client, connection)).toMatchSnapshot();
      expect(toolLaunch(client, connection)).toMatchSnapshot();
    });
  }
  for (const shell of ['powershell', 'bash'] as const) {
    it(`generates ${shell} curl with literal-safe quoting`, () => {
      expect(curlSnippet(connection, shell)).toMatchSnapshot();
      const hostile = { ...connection, secret: "key's $env:PATH $(echo test) ` special" };
      const code = curlSnippet(hostile, shell);
      expect(code).toContain(shell === 'powershell' ? "key''s" : "key'\\''s");
      expect(code).toContain(shell === 'powershell' ? ' `\n' : ' \\\n');
      expect(code).not.toContain(shell === 'powershell' ? ' \\\n' : ' `\n');
    });
  }
});
