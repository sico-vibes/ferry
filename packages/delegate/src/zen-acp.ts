import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectCli } from './index.js';
import { parseOpencodeAuthStore } from './cli-connection/parse.js';
import { runOpenCodeAcp, type OpenCodeCredentialMode } from './opencode-acp.js';
import type { ZenTool, ZenToolCall } from './zen-tools.js';

async function zenAuthRecords(environment: NodeJS.ProcessEnv) {
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  try {
    return parseOpencodeAuthStore(
      JSON.parse(await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')),
    );
  } catch {
    return [];
  }
}

export async function detectZenCli(
  ferryKey?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const detection = await detectCli('opencode', { checkAuth: false, environment });
  const records = await zenAuthRecords(environment);
  const hasOpencode =
    Boolean(environment.OPENCODE_API_KEY) ||
    records.some((record) => record.providerId === 'opencode');
  const hasOpencodeGo = records.some((record) => record.providerId === 'opencode-go');
  return {
    available: detection.available,
    version: detection.version,
    executable: detection.available ? detection.executable : null,
    credentialSource: hasOpencode
      ? ('opencode' as const)
      : hasOpencodeGo
        ? ('opencode_go' as const)
        : ferryKey
          ? ('ferry' as const)
          : ('anonymous' as const),
  };
}

export interface ZenAcpInput {
  model: string;
  /** Entire caller conversation, including real tool results, encoded by Core. */
  prompt: string;
  tools?: readonly ZenTool[];
  apiKey?: string;
  signal: AbortSignal;
  onText?: (text: string) => void;
  onProgress?: () => void;
  environment?: NodeJS.ProcessEnv;
  /** Explicit executable seam for offline integration fixtures. */
  executable?: string;
  executableArgs?: string[];
}
export interface ZenAcpResult {
  text: string;
  toolCalls: ZenToolCall[];
  inputTokens: number;
  outputTokens: number;
}

/** Legacy credential preference: the installed Zen credential first, then the explicit Ferry key. */
async function legacyCredentialMode(
  environment: NodeJS.ProcessEnv,
  apiKey?: string,
): Promise<OpenCodeCredentialMode> {
  if (environment.OPENCODE_API_KEY) return 'installed';
  const records = await zenAuthRecords(environment);
  if (records.some((record) => record.providerId === 'opencode')) return 'installed';
  return apiKey ? 'ferry' : 'anonymous';
}

/**
 * Legacy Zen entry point. Delegates to the generalized OpenCode transport, keeping the Zen-only
 * model validation and the original non-nullable token result shape for existing callers.
 */
export async function runZenAcp(input: ZenAcpInput): Promise<ZenAcpResult> {
  if (!/^opencode\/[^\s]+$/.test(input.model))
    throw new Error('Only OpenCode Zen models use this transport');
  const environment = input.environment ?? process.env;
  const result = await runOpenCodeAcp({
    model: input.model,
    prompt: input.prompt,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    signal: input.signal,
    ...(input.onText ? { onText: input.onText } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    environment,
    ...(input.executable ? { executable: input.executable } : {}),
    ...(input.executableArgs ? { executableArgs: input.executableArgs } : {}),
    credentialMode: await legacyCredentialMode(environment, input.apiKey),
  });
  return {
    text: result.text,
    toolCalls: result.toolCalls,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  };
}
