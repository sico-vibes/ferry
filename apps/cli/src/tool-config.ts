import { join } from 'node:path';

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
const quoted = (value: string) => JSON.stringify(value);
export function openCodeConfig(connection: ToolConnection) {
  return {
    model: `ferry/${connection.model}`,
    provider: {
      ferry: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ferry',
        options: { baseURL: `${connection.url}/v1`, apiKey: connection.secret },
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
export function masked<T>(value: T, secret: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(secret, '[REDACTED]')) as T;
}
export function toolConfigPath(tool: SupportedTool, home: string, env: NodeJS.ProcessEnv): string {
  if (tool === 'claude')
    return join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json');
  if (tool === 'codex') return join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode', 'opencode.json');
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
