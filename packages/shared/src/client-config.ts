export const supportedTools = ['claude', 'codex', 'opencode'] as const;
export type SupportedTool = (typeof supportedTools)[number];
export function isSupportedTool(value: string | undefined): value is SupportedTool {
  return supportedTools.some((tool) => tool === value);
}
export interface ToolConnection {
  url: string;
  secret: string;
  model: string;
}
export interface ToolLaunch {
  command: SupportedTool;
  args: string[];
  env: Record<string, string>;
}
/** Launch the real OpenCode app with its own providers and authentication. */
export function nativeOpenCodeLaunch(model?: string, args: string[] = []): ToolLaunch {
  return { command: 'opencode', args: [...(model ? ['--model', model] : []), ...args], env: {} };
}
export function curlSnippet(connection: ToolConnection, shell: 'powershell' | 'bash'): string {
  const body = JSON.stringify({
    model: connection.model,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  const quote =
    shell === 'powershell'
      ? (text: string) => `'${text.replaceAll("'", "''")}'`
      : (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const continuation = shell === 'powershell' ? ' `\n' : ' \\\n';
  return [
    `${shell === 'powershell' ? 'curl.exe' : 'curl'} ${quote(`${connection.url.replace(/\/$/, '')}/v1/chat/completions`)}`,
    `  -H ${quote(`Authorization: Bearer ${connection.secret}`)}`,
    `  -H ${quote('Content-Type: application/json')}`,
    `  --data-raw ${quote(body)}`,
  ].join(continuation);
}
const quoted = (value: string) => JSON.stringify(value);
export function openAiConfig(connection: ToolConnection) {
  return {
    baseURL: `${connection.url.replace(/\/$/, '')}/v1`,
    apiKey: connection.secret,
    model: connection.model,
  };
}
export function openCodeConfig(connection: ToolConnection) {
  return {
    model: `ferry/${connection.model}`,
    provider: {
      ferry: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ferry',
        options: { baseURL: openAiConfig(connection).baseURL, apiKey: connection.secret },
        models: { [connection.model]: { name: connection.model } },
      },
    },
  };
}
export function toolLaunch(
  tool: SupportedTool,
  connection: ToolConnection,
  args: string[] = [],
): ToolLaunch {
  const url = connection.url.replace(/\/$/, '');
  if (tool === 'claude')
    return {
      command: tool,
      args,
      env: {
        ANTHROPIC_BASE_URL: url,
        ANTHROPIC_AUTH_TOKEN: connection.secret,
        ANTHROPIC_MODEL: connection.model,
      },
    };
  if (tool === 'codex')
    return {
      command: tool,
      args: [
        '-c',
        'model_provider="ferry"',
        '-c',
        `model=${quoted(connection.model)}`,
        '-c',
        'model_providers.ferry.name="Ferry"',
        '-c',
        `model_providers.ferry.base_url=${quoted(`${url}/v1`)}`,
        '-c',
        'model_providers.ferry.env_key="FERRY_GATEWAY_API_KEY"',
        '-c',
        'model_providers.ferry.wire_api="responses"',
        '-c',
        'model_providers.ferry.requires_openai_auth=false',
        ...args,
      ],
      env: { FERRY_GATEWAY_API_KEY: connection.secret },
    };
  return {
    command: tool,
    args,
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig({ ...connection, url })) },
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Existing tool config must be a JSON object');
  return value as Record<string, unknown>;
}
export function configuredContent(
  tool: SupportedTool,
  connection: ToolConnection,
  existing = '',
): string {
  if (tool === 'codex') {
    const firstTable = existing.search(/^\s*\[/m);
    const root = (firstTable < 0 ? existing : existing.slice(0, firstTable)).replace(
      /^\s*(?:model|model_provider)\s*=.*(?:\r?\n|$)/gm,
      '',
    );
    const tables =
      firstTable < 0
        ? ''
        : existing
            .slice(firstTable)
            .replace(/^\[model_providers\.ferry(?:\.[^\]]+)?\][^]*?(?=^\[|$(?![^]))/gm, '');
    return `model = ${quoted(connection.model)}\nmodel_provider = "ferry"\n${root.trim()}\n\n${tables.trim()}\n\n[model_providers.ferry]\nname = "Ferry"\nbase_url = ${quoted(`${connection.url}/v1`)}\nwire_api = "responses"\nrequires_openai_auth = false\nhttp_headers = { Authorization = ${quoted(`Bearer ${connection.secret}`)} }\n`;
  }
  const previous = existing.trim() ? object(JSON.parse(existing)) : {};
  if (tool === 'claude') {
    const env = previous.env === undefined ? {} : object(previous.env);
    return (
      JSON.stringify(
        { ...previous, env: { ...env, ...toolLaunch(tool, connection).env } },
        null,
        2,
      ) + '\n'
    );
  }
  const provider = previous.provider === undefined ? {} : object(previous.provider);
  const config = openCodeConfig(connection);
  return (
    JSON.stringify(
      { ...previous, model: config.model, provider: { ...provider, ...config.provider } },
      null,
      2,
    ) + '\n'
  );
}
