import { configuredContent, curlSnippet, openAiConfig } from '@ferry/shared';
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
  const connection = { url: baseUrl.replace(/\/$/, ''), model, secret: keyPlaceholder };
  return [
    {
      id: 'opencode',
      label: 'OpenCode',
      where: 'opencode.json in your project (or ~/.config/opencode/opencode.json)',
      language: 'json',
      code: configuredContent('opencode', connection),
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      where: '~/.claude/settings.json',
      language: 'json',
      code: configuredContent('claude', connection),
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      where: '~/.codex/config.toml',
      language: 'toml',
      code: configuredContent('codex', connection),
    },
    {
      id: 'openai',
      label: 'OpenAI compatible',
      where: 'Client configuration',
      language: 'json',
      code: JSON.stringify(openAiConfig(connection), null, 2),
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
      label: 'curl (Bash)',
      where: 'Bash',
      language: 'shell',
      code: curlSnippet(connection, 'bash'),
    },
    {
      id: 'curl-powershell',
      label: 'curl (PowerShell)',
      where: 'PowerShell',
      language: 'powershell',
      code: curlSnippet(connection, 'powershell'),
    },
  ];
}
