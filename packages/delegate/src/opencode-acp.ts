import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ClientConnection,
  SessionConfigOption,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';
import { execa } from 'execa';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { rememberSecret } from '@ferry/shared';
import { commandInvocation, detectCli } from './index.js';
import { privateChildEnvironment } from './cli-transport/process.js';
import { parseOpencodeAuthStore } from './cli-connection/parse.js';
import { openZenToolBridge, type ZenTool, type ZenToolCall } from './zen-tools.js';

let active = 0;

/** Credential source for one OpenCode ACP invocation. */
export type OpenCodeCredentialMode = 'installed' | 'anonymous' | 'ferry';

export type OpenCodeAcpErrorCategory =
  | 'busy'
  | 'model_unavailable'
  | 'unsupported_option'
  | 'credential'
  | 'cancelled'
  | 'timeout'
  | 'provider'
  | 'protocol';

/** Transport error with optional HTTP-style status and quota reset metadata. */
export class OpenCodeAcpError extends Error {
  readonly category: OpenCodeAcpErrorCategory;
  readonly statusCode: number | undefined;
  readonly resetAt: string | null;
  constructor(
    message: string,
    options: {
      category?: OpenCodeAcpErrorCategory;
      statusCode?: number;
      resetAt?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'OpenCodeAcpError';
    this.category = options.category ?? 'protocol';
    this.statusCode = options.statusCode;
    this.resetAt = options.resetAt ?? null;
  }
}

/** Structural guard so Core can normalize an OpenCode failure without importing the class. */
export function isOpenCodeAcpError(value: unknown): value is OpenCodeAcpError {
  return value instanceof OpenCodeAcpError;
}

export interface OpenCodeAcpInput {
  /** Exact selected upstream model `<provider>/<id>`; no hidden fallback is used. */
  model: string;
  /** Entire caller conversation, including real tool results, encoded by Core. */
  prompt: string;
  tools?: readonly ZenTool[];
  /** Explicit Ferry-held key, only used by `credentialMode: 'ferry'`. */
  apiKey?: string;
  signal: AbortSignal;
  onText?: (text: string) => void;
  onProgress?: () => void;
  environment?: NodeJS.ProcessEnv;
  /** Explicit executable seam for offline integration fixtures. */
  executable?: string;
  executableArgs?: string[];
  /** Reported option token (effort/thinking variant); must be advertised before prompting. */
  variant?: string | null;
  speed?: 'standard' | 'fast';
  credentialMode?: OpenCodeCredentialMode;
  /** Explicit provider entry offered by the caller (e.g. `opencode-go` for a Go test). */
  credentialProvider?: string;
  timeoutMs?: number;
}

export interface OpenCodeAcpUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

export interface OpenCodeAcpResult {
  text: string;
  toolCalls: ZenToolCall[];
  usage: OpenCodeAcpUsage;
  responseModel: string;
}

const EMPTY_USAGE: OpenCodeAcpUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
};

const MODEL_REF = /^([a-z0-9][a-z0-9._-]*)\/([^\s/][^\s]*)$/i;
const ACTIVE_LIMIT = 4;

/** Parse `<provider>/<id>`. Returns `null` for a malformed ref (no provider namespace). */
export function parseOpenCodeModelRef(
  model: string,
): { providerId: string; modelId: string } | null {
  const match = MODEL_REF.exec(model.trim());
  if (!match?.[1] || !match[2]) return null;
  return { providerId: match[1], modelId: match[2] };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Map ACP usage to nullable per-dimension fields: reported zeros stay `0`, absent stays `null`. */
export function mapOpenCodeUsage(usage: unknown): OpenCodeAcpUsage {
  if (typeof usage !== 'object' || usage === null) return { ...EMPTY_USAGE };
  const raw = usage as Record<string, unknown>;
  const read = asNumber(raw.cachedReadTokens);
  const write = asNumber(raw.cachedWriteTokens);
  return {
    inputTokens: asNumber(raw.inputTokens),
    outputTokens: asNumber(raw.outputTokens),
    cachedTokens: read === null && write === null ? null : (read ?? 0) + (write ?? 0),
    reasoningTokens: asNumber(raw.thoughtTokens),
  };
}

function selectValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== 'select') return [];
  const values: SessionConfigSelectOption[] = [];
  for (const entry of option.options) {
    if ('options' in entry) values.push(...entry.options);
    else values.push(entry);
  }
  return values;
}

function matches(option: SessionConfigOption, pattern: RegExp): boolean {
  return pattern.test(`${option.id} ${option.name}`);
}

function findModelSelector(options: readonly SessionConfigOption[]) {
  return options.find((option) => option.type === 'select' && option.category === 'model');
}

function findVariantSelector(options: readonly SessionConfigOption[]) {
  return options.find(
    (option) =>
      option.category === 'thought_level' ||
      option.category === 'model_config' ||
      matches(option, /variant|effort|reasoning|thought/i),
  );
}

function findSpeedSelector(options: readonly SessionConfigOption[]) {
  return options.find((option) => matches(option, /speed|fast|priority/i));
}

async function readNativeOpencodeCredential(
  environment: NodeJS.ProcessEnv,
  providerId: string,
): Promise<string | null> {
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8'),
    );
    return (
      parseOpencodeAuthStore(raw).find((record) => record.providerId === providerId)?.key ?? null
    );
  } catch {
    return null;
  }
}

function nativeCredentialEnvs(environment: NodeJS.ProcessEnv): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string') continue;
    if (/^OPENCODE_.*(KEY|TOKEN)$/i.test(key)) entries[key] = value;
  }
  return entries;
}

interface ResolvedCredential {
  mode: OpenCodeCredentialMode;
  /** Credential injected as `OPENCODE_API_KEY`, or `undefined` to leave native auth untouched. */
  apiKey: string | undefined;
  /** Providers that stay enabled in the private config. */
  enabledProviders: string[];
}

async function resolveCredential(
  input: OpenCodeAcpInput,
  providerId: string,
  environment: NodeJS.ProcessEnv,
): Promise<ResolvedCredential> {
  const mode: OpenCodeCredentialMode = input.credentialMode ?? 'installed';
  const enabledProviders = new Set([providerId]);
  if (input.credentialProvider) enabledProviders.add(input.credentialProvider);

  if (mode === 'anonymous') {
    if (input.credentialProvider)
      throw new OpenCodeAcpError(
        'Anonymous OpenCode mode cannot use a provider credential. No fallback was used.',
        { category: 'credential' },
      );
    return { mode, apiKey: undefined, enabledProviders: [...enabledProviders] };
  }
  if (mode === 'ferry') {
    if (!input.apiKey)
      throw new OpenCodeAcpError(
        'Ferry credential mode requires an explicit apiKey. No installed key was used.',
        { category: 'credential' },
      );
    return { mode, apiKey: input.apiKey, enabledProviders: [...enabledProviders] };
  }
  // installed: reuse a native credential entry only when an explicit provider is offered.
  if (input.credentialProvider && input.credentialProvider !== providerId) {
    const native = await readNativeOpencodeCredential(environment, input.credentialProvider);
    if (!native)
      throw new OpenCodeAcpError(
        `No installed credential for ${input.credentialProvider}. No fallback was used.`,
        { category: 'credential' },
      );
    return { mode, apiKey: native, enabledProviders: [...enabledProviders] };
  }
  return { mode, apiKey: environment.OPENCODE_API_KEY, enabledProviders: [...enabledProviders] };
}

function buildConfig(model: string, enabledProviders: readonly string[]) {
  return {
    model,
    small_model: model,
    enabled_providers: [...enabledProviders],
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
}

function buildChildEnvironment(
  base: NodeJS.ProcessEnv,
  root: string,
  credential: ResolvedCredential,
  config: unknown,
): NodeJS.ProcessEnv {
  // Pin PWD/cwd to the private root and drop any inherited OpenCode config-file pointers so the
  // parent's `PWD`, project `opencode.json`, plugins, rules, hooks and external MCP servers can
  // never be discovered. `OPENCODE_DISABLE_PROJECT_CONFIG` is the installed CLI's documented switch
  // for skipping project-local config discovery (verified in the 1.18.35 binary); it is defense in
  // depth on top of the private PWD, not a replacement for it.
  const env: NodeJS.ProcessEnv = privateChildEnvironment(base, root, {
    remove: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'],
  });
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.XDG_CONFIG_HOME = join(root, 'config');
  env.XDG_CACHE_HOME = join(root, 'cache');
  env.XDG_STATE_HOME = join(root, 'state');
  if (credential.mode === 'installed') {
    // Keep the native data root so native-owned auth/session data stays authoritative.
    if (credential.apiKey !== undefined) env.OPENCODE_API_KEY = credential.apiKey;
  } else {
    // Private data root hides the user's auth store; only an explicit Ferry key may be injected.
    env.XDG_DATA_HOME = join(root, 'data');
    env.OPENCODE_API_KEY = credential.apiKey;
    if (credential.mode === 'anonymous')
      for (const key of Object.keys(nativeCredentialEnvs(base))) Reflect.deleteProperty(env, key);
  }
  return env;
}

/**
 * Genuine installed OpenCode ACP transport. Selects the exact native advertised model, applies a
 * requested variant/speed only when the ACP config options advertise it, streams caller tool calls
 * back without executing them, and keeps a strict private context (config/plugins/rules/cwd) while
 * leaving native-owned credentials and session data untouched.
 */
export async function runOpenCodeAcp(input: OpenCodeAcpInput): Promise<OpenCodeAcpResult> {
  const ref = parseOpenCodeModelRef(input.model);
  if (!ref)
    throw new OpenCodeAcpError(
      `Invalid OpenCode model ref '${input.model}'. Expected <provider>/<model>.`,
      { category: 'model_unavailable' },
    );
  input.signal.throwIfAborted();
  if (active >= ACTIVE_LIMIT)
    throw new OpenCodeAcpError('OpenCode CLI is busy. Retry when a request finishes.', {
      category: 'busy',
      statusCode: 429,
    });

  active += 1;
  let root: string | undefined;
  let bridge: Awaited<ReturnType<typeof openZenToolBridge>> | undefined;
  let connection: ClientConnection | undefined;
  let terminate: (() => Promise<void>) | undefined;
  let sessionId: string | undefined;
  let executable: string | undefined;
  let baseArgs: string[] | undefined;
  const controller = new AbortController();
  const abort = () => {
    controller.abort(input.signal.reason);
  };
  input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new OpenCodeAcpError('OpenCode CLI request timed out', { category: 'timeout' }),
    );
  }, input.timeoutMs ?? 120_000);
  const acpToolCallIds: string[] = [];
  let text = '';
  try {
    const environment = input.environment ?? process.env;
    const detection = input.executable
      ? null
      : await detectCli('opencode', { checkAuth: false, environment });
    executable =
      input.executable ??
      (detection?.available && detection.executable ? detection.executable : undefined);
    baseArgs = input.executableArgs ?? [];
    if (!executable)
      throw new OpenCodeAcpError(
        'OpenCode CLI not installed. Install OpenCode, then detect again.',
        {
          category: 'provider',
        },
      );
    controller.signal.throwIfAborted();
    const credential = await resolveCredential(input, ref.providerId, environment);
    if (credential.apiKey) rememberSecret(credential.apiKey);
    root = await mkdtemp(join(tmpdir(), 'ferry-opencode-'));
    bridge = await openZenToolBridge(input.tools ?? []);
    const config = buildConfig(input.model, credential.enabledProviders);
    const spawnArgs = input.executableArgs ?? ['acp'];
    const invocation = commandInvocation(executable, spawnArgs);
    const child = execa(invocation.file, invocation.args, {
      cwd: root,
      env: buildChildEnvironment(environment, root, credential, config),
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
        throw new Error('Host file access is disabled for the OpenCode transport');
      })
      .onRequest('fs/write_text_file', () => {
        throw new Error('Host file writes are disabled for the OpenCode transport');
      })
      .onRequest('session/request_permission', ({ params }) => {
        const reject = params.options.find((option) => option.kind === 'reject_once');
        return reject
          ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' } };
      })
      .onNotification('session/update', ({ params }) => {
        if (!controller.signal.aborted) input.onProgress?.();
        const update = params.update;
        if (update.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string')
          acpToolCallIds.push(update.toolCallId);
        if (
          !controller.signal.aborted &&
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
        ) {
          text += update.content.text;
          input.onText?.(update.content.text);
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
    const work = async (): Promise<OpenCodeAcpResult> => {
      await currentConnection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'Ferry', version: '0.9.0' },
      });
      input.onProgress?.();
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
      sessionId = session.sessionId;
      input.onProgress?.();
      let options: SessionConfigOption[] = session.configOptions ?? [];

      const modelSelector = findModelSelector(options);
      if (
        !modelSelector ||
        !selectValues(modelSelector).some((option) => option.value === input.model)
      )
        throw new OpenCodeAcpError(
          `Requested model ${input.model} is unavailable in this OpenCode CLI. No fallback was used.`,
          { category: 'model_unavailable' },
        );
      options = await setSelectOption(
        currentConnection.agent,
        session.sessionId,
        modelSelector,
        input.model,
      );

      if (input.variant != null) {
        const variantSelector = findVariantSelector(options);
        if (!variantSelector)
          throw new OpenCodeAcpError(
            `Variant ${input.variant} is not configurable for ${input.model}. No fallback was used.`,
            { category: 'unsupported_option' },
          );
        options = await setSelectOption(
          currentConnection.agent,
          session.sessionId,
          variantSelector,
          input.variant,
        );
      }

      if (input.speed === 'fast') {
        const speedSelector = findSpeedSelector(options);
        if (!speedSelector)
          throw new OpenCodeAcpError(
            `Fast speed is not configurable for ${input.model}. No fallback was used.`,
            { category: 'unsupported_option' },
          );
        options = await setSpeedOption(
          currentConnection.agent,
          session.sessionId,
          speedSelector,
          true,
        );
      } else if (input.speed === 'standard') {
        const speedSelector = findSpeedSelector(options);
        if (speedSelector)
          options = await setSpeedOption(
            currentConnection.agent,
            session.sessionId,
            speedSelector,
            false,
          );
      }

      const responseModel =
        selectValues(findModelSelector(options) ?? modelSelector).find(
          (option) => option.value === input.model,
        )?.value ?? input.model;

      const prompt = currentConnection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      });
      const outcome = await Promise.race([
        prompt.then((value) => ({ value })),
        toolBridge.called.then((call) => ({ call })),
      ]);
      if ('call' in outcome) {
        const realId = acpToolCallIds[0];
        const call = realId ? { ...outcome.call, id: realId } : outcome.call;
        return { text, toolCalls: [call], usage: { ...EMPTY_USAGE }, responseModel };
      }
      if (outcome.value.stopReason === 'cancelled')
        throw new OpenCodeAcpError('OpenCode cancelled this request', { category: 'cancelled' });
      return { text, toolCalls: [], usage: mapOpenCodeUsage(outcome.value.usage), responseModel };
    };
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        const cancelled = () => {
          const reason: unknown = controller.signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new OpenCodeAcpError('OpenCode request cancelled', { category: 'cancelled' }),
          );
        };
        if (controller.signal.aborted) cancelled();
        else controller.signal.addEventListener('abort', cancelled, { once: true });
      }),
      child.then(() => {
        throw new OpenCodeAcpError('OpenCode CLI exited before finishing the request', {
          category: 'protocol',
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
    controller.abort();
    await terminate?.();
    connection?.close();
    await bridge?.close();
    if (
      sessionId &&
      executable &&
      baseArgs !== undefined &&
      (input.credentialMode ?? 'installed') === 'installed'
    )
      await deleteNativeSession(executable, baseArgs, input.environment ?? process.env, sessionId);
    try {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } finally {
      active--;
    }
  }
}

async function setSelectOption(
  agent: ClientConnection['agent'],
  sessionId: string,
  selector: SessionConfigOption,
  value: string,
): Promise<SessionConfigOption[]> {
  if (
    selector.type !== 'select' ||
    !selectValues(selector).some((option) => option.value === value)
  )
    throw new OpenCodeAcpError(
      `Option value '${value}' is not advertised for ${selector.id}. No fallback was used.`,
      { category: 'unsupported_option' },
    );
  const response = (await agent.request('session/set_config_option', {
    sessionId,
    configId: selector.id,
    value,
  })) as { configOptions?: SessionConfigOption[] | null };
  return response.configOptions ?? [];
}

async function setSpeedOption(
  agent: ClientConnection['agent'],
  sessionId: string,
  selector: SessionConfigOption,
  fast: boolean,
): Promise<SessionConfigOption[]> {
  if (selector.type === 'boolean') {
    const response = (await agent.request('session/set_config_option', {
      sessionId,
      configId: selector.id,
      type: 'boolean',
      value: fast,
    })) as { configOptions?: SessionConfigOption[] | null };
    return response.configOptions ?? [];
  }
  const values = selectValues(selector);
  const wanted = fast
    ? values.find((option) => /fast|priority/i.test(`${option.value} ${option.name}`))
    : values.find((option) =>
        /standard|default|normal|off/i.test(`${option.value} ${option.name}`),
      );
  if (!wanted)
    throw new OpenCodeAcpError(
      `Speed '${fast ? 'fast' : 'standard'}' is not advertised for ${selector.id}. No fallback was used.`,
      { category: 'unsupported_option' },
    );
  const response = (await agent.request('session/set_config_option', {
    sessionId,
    configId: selector.id,
    value: wanted.value,
  })) as { configOptions?: SessionConfigOption[] | null };
  return response.configOptions ?? [];
}

/** Best-effort removal of the single Ferry-owned session; never lists or touches other history. */
async function deleteNativeSession(
  executable: string,
  baseArgs: string[],
  environment: NodeJS.ProcessEnv,
  sessionId: string,
): Promise<void> {
  try {
    const invocation = commandInvocation(executable, [...baseArgs, 'session', 'delete', sessionId]);
    await execa(invocation.file, invocation.args, {
      env: environment,
      extendEnv: false,
      windowsHide: true,
      stdio: 'ignore',
      reject: false,
      timeout: 10_000,
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    /* Native cleanup is best-effort; never surface credential/history text. */
  }
}
