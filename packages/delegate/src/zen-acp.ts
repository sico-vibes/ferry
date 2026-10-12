import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ClientConnection } from '@agentclientprotocol/sdk';
import { execa } from 'execa';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { rememberSecret } from '@ferry/shared';
import { commandInvocation, detectCli } from './index.js';
import { openZenToolBridge, type ZenTool, type ZenToolCall } from './zen-tools.js';

const authSchema = z.object({
  opencode: z.object({ type: z.literal('api'), key: z.string().min(1) }).optional(),
});
async function zenCredential(environment: NodeJS.ProcessEnv) {
  if (environment.OPENCODE_API_KEY) return environment.OPENCODE_API_KEY;
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  try {
    return authSchema.parse(
      JSON.parse(await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')),
    ).opencode?.key;
  } catch {
    return undefined;
  }
}

export async function detectZenCli(
  ferryKey?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const detection = await detectCli('opencode', { checkAuth: false, environment });
  const credential = await zenCredential(environment);
  return {
    available: detection.available,
    version: detection.version,
    executable: detection.available ? detection.executable : null,
    credentialSource: credential
      ? ('opencode' as const)
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

let active = 0;
/** Genuine OpenCode ACP, isolated from the user's project/config and caller tools. */
export async function runZenAcp(input: ZenAcpInput): Promise<ZenAcpResult> {
  if (!/^opencode\/[^\s]+$/.test(input.model))
    throw new Error('Only OpenCode Zen models use this transport');
  input.signal.throwIfAborted();
  if (active >= 4)
    throw Object.assign(new Error('OpenCode CLI is busy. Retry when a request finishes.'), {
      statusCode: 429,
    });
  active++;
  let root: string | undefined;
  let bridge: Awaited<ReturnType<typeof openZenToolBridge>> | undefined;
  let connection: ClientConnection | undefined;
  let terminate: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  const abort = () => {
    controller.abort(input.signal.reason);
  };
  input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error('OpenCode CLI request timed out'));
  }, 120_000);
  let text = '';
  try {
    const environment = input.environment ?? process.env;
    const credential = (await zenCredential(environment)) ?? input.apiKey;
    if (credential) rememberSecret(credential);
    const detection = input.executable ? null : await detectZenCli(input.apiKey, environment);
    const executable = input.executable ?? detection?.executable;
    if (!executable)
      throw new Error('OpenCode CLI not installed. Install OpenCode, then detect again.');
    controller.signal.throwIfAborted();
    root = await mkdtemp(join(tmpdir(), 'ferry-zen-'));
    bridge = await openZenToolBridge(input.tools ?? []);
    const config = {
      model: input.model,
      small_model: input.model,
      enabled_providers: ['opencode'],
      share: 'disabled',
      autoupdate: false,
      permission: { '*': 'ask', 'ferry_tools_*': 'allow' },
      agent: {
        ferry: {
          mode: 'primary',
          prompt:
            'Answer the supplied conversation. Use only ferry_tools caller tools. Their execution and approvals belong to the caller. Never access the host workspace or run native tools.',
        },
      },
      default_agent: 'ferry',
      mcp: {},
      plugin: [],
      instructions: [],
      formatter: false,
      lsp: false,
    };
    const invocation = commandInvocation(executable, input.executableArgs ?? ['acp']);
    // XDG isolation prevents loading user plugins/rules or writing user sessions.
    // Only the selected Zen credential is passed, never other provider accounts.
    const child = execa(invocation.file, invocation.args, {
      cwd: root,
      env: {
        ...environment,
        OPENCODE_CONFIG: undefined,
        OPENCODE_CONFIG_DIR: undefined,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_STATE_HOME: join(root, 'state'),
        OPENCODE_API_KEY: credential,
      },
      extendEnv: false,
      windowsHide: true,
      buffer: false,
      reject: false,
      detached: process.platform !== 'win32',
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    child.stderr.on('data', () => undefined); // May contain credentials/provider text; never log it.
    child.stdin.on('error', () => connection?.close());
    terminate = async () => {
      if (child.pid !== undefined) {
        if (process.platform === 'win32')
          await execa('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            reject: false,
            windowsHide: true,
            timeout: 3000,
          }).catch(() => undefined);
        else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
      await child.catch(() => undefined);
    };
    const acp = client({ name: 'Ferry' })
      .onRequest('fs/read_text_file', () => {
        throw new Error('Host file access is disabled for the Zen transport');
      })
      .onRequest('fs/write_text_file', () => {
        throw new Error('Host file writes are disabled for the Zen transport');
      })
      .onRequest('session/request_permission', ({ params }) => {
        const reject = params.options.find((option) => option.kind === 'reject_once');
        return reject
          ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' } };
      })
      .onNotification('session/update', ({ params }) => {
        if (!controller.signal.aborted) input.onProgress?.();
        if (
          !controller.signal.aborted &&
          params.update.sessionUpdate === 'agent_message_chunk' &&
          params.update.content.type === 'text'
        ) {
          text += params.update.content.text;
          input.onText?.(params.update.content.text);
        }
      });
    connection = acp.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    const currentConnection = connection;
    const toolBridge = bridge;
    const workspace = root;
    const work = async (): Promise<ZenAcpResult> => {
      await currentConnection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'Ferry', version: '0.9.0' },
      });
      input.onProgress?.();
      // Advertising authentication methods does not mean authentication is required.
      const session = await currentConnection.agent.request('session/new', {
        cwd: workspace,
        mcpServers: input.tools?.length
          ? [
              {
                type: 'http',
                name: 'ferry_tools',
                url: toolBridge.url,
                headers: [{ name: 'Authorization', value: `Bearer ${toolBridge.token}` }],
              },
            ]
          : [],
      });
      input.onProgress?.();
      const selector = session.configOptions?.find(
        (option) => option.type === 'select' && option.category === 'model',
      );
      if (
        selector?.type !== 'select' ||
        !selector.options
          .flatMap((option) => ('options' in option ? option.options : [option]))
          .some((option) => option.value === input.model)
      )
        throw new Error(
          'Requested Zen free model is unavailable in this OpenCode CLI. No fallback was used.',
        );
      await currentConnection.agent.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: selector.id,
        type: 'select',
        value: input.model,
      });
      const prompt = currentConnection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      });
      const outcome = await Promise.race([
        prompt.then((value) => ({ value })),
        toolBridge.called.then((call) => ({ call })),
      ]);
      if ('call' in outcome)
        return { text, toolCalls: [outcome.call], inputTokens: 0, outputTokens: 0 };
      if (outcome.value.stopReason === 'cancelled')
        throw new Error('OpenCode cancelled this request');
      return {
        text,
        toolCalls: [],
        inputTokens: outcome.value.usage?.inputTokens ?? 0,
        outputTokens: outcome.value.usage?.outputTokens ?? 0,
      };
    };
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        const cancelled = () => {
          const reason: unknown = controller.signal.reason;
          reject(reason instanceof Error ? reason : new Error('OpenCode request cancelled'));
        };
        if (controller.signal.aborted) cancelled();
        else controller.signal.addEventListener('abort', cancelled, { once: true });
      }),
      child.then(() => {
        throw new Error('OpenCode CLI exited before finishing the request');
      }),
    ]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
    controller.abort();
    await terminate?.();
    connection?.close();
    await bridge?.close();
    try {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } finally {
      active--;
    }
  }
}
