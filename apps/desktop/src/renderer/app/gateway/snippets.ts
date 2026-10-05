export interface GatewaySnippet {
  id: string;
  label: string;
  /** Where the snippet goes, shown above the code. */
  where: string;
  language: 'json' | 'toml' | 'yaml' | 'powershell' | 'shell';
  code: string;
}

const keyPlaceholder = 'YOUR_FERRY_KEY';

/** Copy-paste setup for common OpenAI/Anthropic-compatible tools. */
export function gatewaySnippets(baseUrl: string, model = 'ferry/auto-free'): GatewaySnippet[] {
  const openAiBase = `${baseUrl}/v1`;
  return [
    {
      id: 'opencode',
      label: 'OpenCode',
      where: 'opencode.json in your project (or ~/.config/opencode/opencode.json)',
      language: 'json',
      code: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: {
            ferry: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Ferry',
              options: { baseURL: openAiBase, apiKey: keyPlaceholder },
              models: {
                'ferry/auto-free': { name: 'Ferry Auto-Free' },
                'ferry/best': { name: 'Ferry Best Available' },
                'ferry/fast': { name: 'Ferry Fast' },
              },
            },
          },
          model: `ferry/${model}`,
        },
        null,
        2,
      ),
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      where: 'PowerShell, before starting claude',
      language: 'powershell',
      code: [
        `$env:ANTHROPIC_BASE_URL = '${baseUrl}'`,
        `$env:ANTHROPIC_AUTH_TOKEN = '${keyPlaceholder}'`,
        `$env:ANTHROPIC_MODEL = '${model}'`,
        'claude',
      ].join('\n'),
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      where: '~/.codex/config.toml, then set FERRY_API_KEY',
      language: 'toml',
      code: [
        `model = "${model}"`,
        'model_provider = "ferry"',
        '',
        '[model_providers.ferry]',
        'name = "Ferry"',
        `base_url = "${openAiBase}"`,
        'env_key = "FERRY_API_KEY"',
        'wire_api = "chat"',
      ].join('\n'),
    },
    {
      id: 'aider',
      label: 'Aider',
      where: 'PowerShell',
      language: 'powershell',
      code: [
        `$env:OPENAI_API_BASE = '${openAiBase}'`,
        `$env:OPENAI_API_KEY = '${keyPlaceholder}'`,
        `aider --model openai/${model}`,
      ].join('\n'),
    },
    {
      id: 'continue',
      label: 'Continue',
      where: '~/.continue/config.yaml (Cline, Roo and Kilo: choose "OpenAI Compatible")',
      language: 'yaml',
      code: [
        'models:',
        '  - name: Ferry Auto-Free',
        '    provider: openai',
        `    model: ${model}`,
        `    apiBase: ${openAiBase}`,
        `    apiKey: ${keyPlaceholder}`,
      ].join('\n'),
    },
    {
      id: 'curl',
      label: 'curl',
      where: 'Any terminal (use curl.exe in PowerShell)',
      language: 'shell',
      code: [
        `curl ${openAiBase}/chat/completions \\`,
        `  -H "Authorization: Bearer ${keyPlaceholder}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`,
      ].join('\n'),
    },
  ];
}
