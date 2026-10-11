import { join } from 'node:path';
import type { SupportedTool } from '@ferry/shared';
export {
  supportedTools,
  isSupportedTool,
  toolLaunch,
  openCodeConfig,
  configuredContent,
} from '@ferry/shared';
export type { SupportedTool, ToolConnection, ToolLaunch } from '@ferry/shared';
export function masked<T>(value: T, secret: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(secret, '[REDACTED]')) as T;
}
export function toolConfigPath(tool: SupportedTool, home: string, env: NodeJS.ProcessEnv): string {
  if (tool === 'claude')
    return join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json');
  if (tool === 'codex') return join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode', 'opencode.json');
}
