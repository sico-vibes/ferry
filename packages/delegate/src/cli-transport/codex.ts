import type { CliAccountKey, CliConnection, CliUsageSnapshot, CliUsageWindow } from '@ferry/shared';
import { CliTransportError, asCliTransportError } from './errors.js';
import { isRecord, asArray, str, num } from './coerce.js';
import {
  commandInvocation,
  createPrivateWorkingDir,
  isUnsafeArgument,
  privateChildEnvironment,
  removePrivateWorkingDir,
  resolveExecutable,
  spawnCliProcess,
  type CliProcess,
} from './process.js';
import { JsonRpcRequestError, NdjsonJsonRpcPeer } from './rpc.js';
import { redactText } from './redact.js';
import {
  checkPluginList,
  configuredMcpNames,
  configuredPlugins,
  disabledPluginOverrides,
  disabledServerOverrides,
  managedHooksConfigured,
  notifyStillConfigured,
  tomlKeySegment,
  type ConfiguredPlugins,
} from './codex-config.js';
import {
  assertCodexCompatible,
  accountKeyOf,
  normalizePlan,
  resolveOptions,
  FERRY_CLIENT_NAME,
  FERRY_CLIENT_VERSION,
} from './validate.js';
import {
  emptyTurnUsage,
  type CliTurnResult,
  type CliTurnToolCall,
  type CliTransportInput,
} from './types.js';

/** Minimum app-server protocol: the exact installed 0.162.1 schema bundle. */
const CODEX_MIN_VERSION: readonly [number, number, number] = [0, 162, 1];
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

interface TokenBreakdown {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * Read one usage snapshot, keeping each reported dimension (a reported `0` stays `0`) and nulling
 * only the dimensions the CLI omitted. A whole snapshot is never discarded for one missing field.
 */
function readBreakdown(value: unknown): TokenBreakdown | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: num(value.inputTokens),
    outputTokens: num(value.outputTokens),
    cachedTokens: num(value.cachedInputTokens),
    reasoningTokens: num(value.reasoningOutputTokens),
  };
}

/**
 * Parse the native Codex version from the first semver token in `userAgent`. The real UA is like
 * `Codex Desktop/0.162.1 (Windows 10.0.26300; x86_64) dumb (ferry_readonly_probe; 0.9.0)`, so the
 * first match is the native Codex version, never Ferry's own trailing version.
 */
function parseVersion(userAgent: unknown): [number, number, number] | null {
  if (typeof userAgent !== 'string') return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(userAgent);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function assertCodexVersion(userAgent: unknown, accountKey: string | null): void {
  const version = parseVersion(userAgent);
  if (!version)
    throw new CliTransportError(
      'unsupported_capability',
      'Could not determine the Codex app-server version; install or update the Codex CLI',
      { accountKey },
    );
  const min = CODEX_MIN_VERSION;
  const older =
    version[0] < min[0] ||
    (version[0] === min[0] && version[1] < min[1]) ||
    (version[0] === min[0] && version[1] === min[1] && version[2] < min[2]);
  if (older)
    throw new CliTransportError(
      'unsupported_capability',
      `Codex ${version.join('.')} predates the Ferry app-server protocol (needs ${min.join('.')}); update the Codex CLI`,
      { accountKey },
    );
}

/**
 * Reject a native account/source that contradicts the supplied connection BEFORE prompting, so
 * Ferry never silently spends through an API key, a different account, or Bedrock when the caller
 * authorized a subscription connection.
 */
function assertCodexAccount(
  account: unknown,
  connection: CliConnection,
  billing: CliConnection['models'][number]['billing'],
  accountKey: string | null,
): void {
  if (!isRecord(account)) return;
  if (account.requiresOpenaiAuth === true && !account.account)
    throw new CliTransportError('authentication', 'Codex is not signed in', { accountKey });
  const current = isRecord(account.account) ? account.account : null;
  if (!current) return;
  const type = str(current.type);
  const subscription =
    normalizePlan(connection.account.plan) !== null || billing === 'included_subscription';
  if (type === 'apiKey' && subscription)
    throw new CliTransportError(
      'authentication',
      'Codex is authenticated with an API key rather than the supplied subscription account; refresh the connection',
      { accountKey },
    );
  if (type === 'amazonBedrock')
    throw new CliTransportError(
      'authentication',
      'Codex is authenticated through Amazon Bedrock rather than the supplied subscription account',
      { accountKey },
    );
  const currentPlan = normalizePlan(str(current.planType));
  const suppliedPlan = normalizePlan(connection.account.plan);
  if (currentPlan !== null && suppliedPlan !== null && currentPlan !== suppliedPlan)
    throw new CliTransportError(
      'authentication',
      `Codex plan "${currentPlan}" no longer matches the supplied connection plan "${suppliedPlan}"; refresh the connection`,
      { accountKey },
    );
  const currentEmail = str(current.email)?.trim().toLowerCase() ?? null;
  const suppliedLabel = connection.account.label?.trim().toLowerCase() ?? null;
  if (
    currentEmail !== null &&
    suppliedLabel !== null &&
    suppliedLabel.includes('@') &&
    currentEmail !== suppliedLabel
  )
    throw new CliTransportError(
      'authentication',
      'Codex signed-in account differs from the supplied connection; refresh the connection',
      { accountKey },
    );
}

const FAST_TIER = /fast|priority/i;

/** Select the advertised fast tier by id/name; a default tier is often listed first, so never take [0]. */
function selectFastTier(tiers: unknown[]): string | null {
  for (const entry of tiers) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    const name = str(entry.name);
    if (id && (FAST_TIER.test(id) || (name !== null && FAST_TIER.test(name)))) return id;
  }
  return null;
}

interface ToolRoute {
  alias: string;
  tool: { name: string; description?: string; parameters: Record<string, unknown> };
}

function buildToolRoutes(tools: CliTransportInput['tools']): {
  specs: Record<string, unknown>[];
  byAlias: Map<string, ToolRoute['tool']>;
  aliasByName: Map<string, string>;
} {
  const specs: Record<string, unknown>[] = [];
  const byAlias = new Map<string, ToolRoute['tool']>();
  const aliasByName = new Map<string, string>();
  tools.forEach((tool, index) => {
    const alias = `ferry_tool_${String(index)}`;
    byAlias.set(alias, tool);
    if (!aliasByName.has(tool.name)) aliasByName.set(tool.name, alias);
    specs.push({
      type: 'function',
      name: alias,
      description: tool.description?.trim()
        ? `${tool.name}: ${tool.description}`
        : `${tool.name} (caller-owned tool)`,
      inputSchema:
        Object.keys(tool.parameters).length > 0
          ? tool.parameters
          : { type: 'object', properties: {} },
    });
  });
  return { specs, byAlias, aliasByName };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // fall through to empty arguments
    }
  }
  return {};
}

/**
 * Conversation as Responses API items, used to give a fresh ephemeral thread real history. Caller
 * `system`/`developer` messages are supplied at thread level (baseInstructions/developerInstructions),
 * so they are excluded here to avoid duplicating them in the token-heavy item history.
 */
function conversationItems(
  messages: CliTransportInput['messages'],
  aliasByName: Map<string, string>,
): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;
    const text = message.content ?? '';
    if (message.role === 'assistant') {
      if (text)
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      for (const call of message.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: aliasByName.get(call.function.name) ?? call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: text,
      });
      continue;
    }
    items.push({
      type: 'message',
      role: message.role,
      content: [{ type: 'input_text', text }],
    });
  }
  return items;
}

/**
 * Truthful, compact caller-owned base instructions. Supplied as `baseInstructions` so the native
 * coding/host base prompt (which advertises shell/filesystem/apply_patch and other host tools) is
 * replaced rather than paid for on every request. Caller `system` messages are appended verbatim.
 */
const FERRY_CODEX_BASE_INSTRUCTIONS = [
  'You are a text-only assistant running inside Ferry, which owns this thread and its tools.',
  'You have NO host capabilities: no shell, filesystem read/write, apply_patch, code mode, images, web search, or network. Never attempt host actions and never claim any host action occurred.',
  'The only tools available are the caller-provided functions listed for this thread. Call at most one when needed, then stop and wait: the caller executes it and returns the real result on the next turn. Never fabricate a tool result.',
  'Follow the caller system/developer instructions and the conversation. Answer concisely.',
].join('\n');

function buildCodexBaseInstructions(messages: CliTransportInput['messages']): string {
  const parts = [FERRY_CODEX_BASE_INSTRUCTIONS];
  for (const message of messages)
    if (message.role === 'system') parts.push(`[caller system]\n${message.content ?? ''}`);
  return parts.join('\n\n');
}

function buildCodexDeveloperInstructions(messages: CliTransportInput['messages']): string | null {
  const parts: string[] = [];
  for (const message of messages)
    if (message.role === 'developer') parts.push(message.content ?? '');
  const joined = parts.join('\n\n').trim();
  return joined.length > 0 ? joined : null;
}

function serializeConversation(messages: CliTransportInput['messages']): string {
  return messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .map((message) => {
      const lines = [`[${message.role}] ${message.content ?? ''}`];
      for (const call of message.tool_calls ?? [])
        lines.push(
          `[assistant tool_call ${call.id}] ${call.function.name}(${call.function.arguments})`,
        );
      if (message.tool_call_id) lines.push(`(tool_call_id: ${message.tool_call_id})`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function normalizeCodexError(
  message: string,
  codexErrorInfo: unknown,
  accountKey: string | null,
  statusCode?: number,
): CliTransportError {
  const info = isRecord(codexErrorInfo)
    ? Object.keys(codexErrorInfo)[0]
    : typeof codexErrorInfo === 'string'
      ? codexErrorInfo
      : null;
  const httpStatus =
    isRecord(codexErrorInfo) && isRecord(codexErrorInfo.httpConnectionFailed)
      ? num(codexErrorInfo.httpConnectionFailed.httpStatusCode)
      : null;
  const status = statusCode ?? httpStatus ?? undefined;
  const lower = message.toLowerCase();
  const withStatus = status === undefined ? { accountKey } : { accountKey, statusCode: status };

  const exhausted =
    info === 'usageLimitExceeded' ||
    info === 'sessionBudgetExceeded' ||
    /usage limit|usage_limit_reached|budget exceeded|credits? (?:depleted|exhausted)/.test(lower);
  if (exhausted) return new CliTransportError('exhausted_capacity', message, withStatus);

  const temporary =
    info === 'rateLimitExceeded' ||
    info === 'serverOverloaded' ||
    info === 'flexUnavailable' ||
    status === 429 ||
    /rate limit|rate_limit|429|overloaded|try again later/.test(lower);
  if (temporary) return new CliTransportError('temporary_rate_limit', message, withStatus);

  if (
    info === 'unauthorized' ||
    status === 401 ||
    status === 403 ||
    /unauthor|not logged in|sign in/.test(lower)
  )
    return new CliTransportError('authentication', message, withStatus);

  if (status === 404 || /model not found|unknown model|unavailable model/.test(lower))
    return new CliTransportError('unavailable_model', message, withStatus);

  return new CliTransportError('provider_error', message, withStatus);
}

function isoFromSeconds(value: unknown): string | null {
  const seconds = num(value);
  if (seconds === null) return null;
  return new Date(seconds * 1000).toISOString();
}

function codexWindows(snapshot: unknown): CliUsageWindow[] {
  if (!isRecord(snapshot)) return [];
  const limitId = str(snapshot.limitId) ?? 'codex';
  const windows: CliUsageWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const window = snapshot[key];
    if (!isRecord(window)) continue;
    const usedPercent = num(window.usedPercent);
    if (usedPercent === null) continue;
    windows.push({
      id: `${limitId}:${key}`,
      label: key === 'primary' ? 'Primary window' : 'Secondary window',
      metric: 'percent',
      windowKind: 'rolling',
      used: usedPercent,
      limit: 100,
      remaining: Math.max(0, 100 - usedPercent),
      utilization: usedPercent / 100,
      resetAt: isoFromSeconds(window.resetsAt),
    });
  }
  return windows;
}

function buildUsageSnapshot(connection: CliConnection, snapshot: unknown): CliUsageSnapshot {
  return {
    connectionId: connection.id,
    accountKey: connection.account.key,
    state: 'available',
    source: 'codex app-server account/rateLimits',
    observedAt: new Date().toISOString(),
    staleAt: null,
    windows: codexWindows(snapshot),
    note: null,
  };
}

interface McpDiscoveryOptions {
  executable: string;
  baseArgs: readonly string[];
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  accountKey: string | null;
}

interface CodexIsolationConfig {
  /** Configured top-level MCP server names. */
  mcpNames: string[];
  /** Configured plugin ids and any declared plugin MCP server names. */
  plugins: ConfiguredPlugins;
}

function invalidCodexConfig(accountKey: string | null): CliTransportError {
  return new CliTransportError(
    'unsupported_capability',
    'Codex app-server did not return a usable effective config; cannot prove inherited MCP/plugin isolation. Update the Codex CLI',
    { accountKey },
  );
}

/**
 * Discover the native MCP/plugin isolation config via a dedicated, bounded app-server probe that
 * ONLY calls `initialize` + `config/read`. `config/read` is non-activating metadata: it never starts
 * an MCP process (verified against the installed 0.162.1 app-server with a sentinel command). The
 * probe runs in a private temp cwd and is torn down before the generation process starts, so no
 * inherited MCP/plugin command can run during account/version/config discovery. Failure rejects the
 * turn closed.
 *
 * Cancellation: an already-aborted signal throws before any temp dir or process is created; a
 * signal that aborts during the awaited temp-dir creation is re-checked before spawn; and a single
 * shared abort promise (one listener) races every request. The caller's remaining deadline is passed
 * in, so the probe shares the turn's overall budget instead of adding a new one.
 */
async function readNativeIsolationConfig(
  options: McpDiscoveryOptions,
): Promise<CodexIsolationConfig> {
  const cancelError = (reason: unknown): CliTransportError =>
    reason instanceof CliTransportError
      ? reason
      : new CliTransportError('cancelled', 'Codex isolation discovery cancelled', {
          accountKey: options.accountKey,
        });
  if (options.signal.aborted) throw cancelError(options.signal.reason);
  const controller = new AbortController();
  const relay = (): void => {
    controller.abort(options.signal.reason);
  };
  options.signal.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new CliTransportError('timeout', 'Codex isolation discovery timed out', {
        accountKey: options.accountKey,
      }),
    );
  }, options.timeoutMs);
  // One abort promise / one controller listener, shared by every request (never re-registered).
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = (): void => {
      reject(cancelError(controller.signal.reason));
    };
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  let cwd: string | undefined;
  let proc: CliProcess | undefined;
  let peer: NdjsonJsonRpcPeer | undefined;
  try {
    cwd = await createPrivateWorkingDir();
    // A signal that aborted while the temp dir was being created must not spawn the probe.
    controller.signal.throwIfAborted();
    const invocation = commandInvocation(options.executable, [
      ...options.baseArgs,
      'app-server',
      ...blanketIsolationCliArgs(),
    ]);
    const probeEnvironment = privateChildEnvironment(options.environment, cwd);
    // Marks this short-lived child as the non-activating config probe (ignored by the real CLI).
    probeEnvironment.FERRY_CODEX_MCP_PROBE = '1';
    proc = spawnCliProcess({
      file: invocation.file,
      args: invocation.args,
      cwd,
      environment: probeEnvironment,
      verbatim: invocation.verbatim,
    });
    const activeProcess: CliProcess = proc;
    const activePeer = new NdjsonJsonRpcPeer({
      write: (line) => {
        activeProcess.stdin.write(line);
      },
      onProtocolError: () => {
        controller.abort(
          new CliTransportError('provider_error', 'Codex isolation discovery protocol error', {
            accountKey: options.accountKey,
          }),
        );
      },
    });
    peer = activePeer;
    activeProcess.stdout.setEncoding('utf8');
    activeProcess.stdout.on('data', (chunk: string) => {
      activePeer.handleChunk(chunk);
    });
    const request = (method: string, params: unknown): Promise<unknown> =>
      Promise.race([activePeer.request(method, params), aborted]);
    await request('initialize', {
      clientInfo: { name: FERRY_CLIENT_NAME, version: FERRY_CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    });
    activePeer.notify('initialized', {});
    const effective = await request('config/read', {});
    if (!isRecord(effective) || !isRecord(effective.config))
      throw invalidCodexConfig(options.accountKey);
    const mcp = effective.config.mcp_servers;
    if (mcp !== undefined && mcp !== null && !isRecord(mcp))
      throw invalidCodexConfig(options.accountKey);
    const plugins = effective.config.plugins;
    if (plugins !== undefined && plugins !== null && !isRecord(plugins))
      throw invalidCodexConfig(options.accountKey);
    return { mcpNames: configuredMcpNames(effective), plugins: configuredPlugins(effective) };
  } catch (error) {
    if (error instanceof CliTransportError) throw error;
    throw new CliTransportError(
      'unsupported_capability',
      'Could not read the Codex app-server config to disable inherited MCP/plugin sources; update the Codex CLI',
      { accountKey: options.accountKey },
    );
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', relay);
    peer?.close();
    await proc?.killTree();
    if (cwd) await removePrivateWorkingDir(cwd);
  }
}

/**
 * Blanket startup `-c` overrides that need no prior enumeration. `features.plugins=false` disables
 * every plugin source (verified: it blanks `plugin/list` and stops plugin MCP startup).
 * `features.hooks=false` (with the documented `features.codex_hooks` alias) disables native global
 * lifecycle hooks loaded from `hooks.json` or inline `[hooks]`, and `notify=[]` clears the native
 * notification command — so no native hook/notify command can run in this private process, including
 * during the non-activating config probe. None of these keys require quoting.
 */
function blanketIsolationCliArgs(): string[] {
  return [
    '-c',
    'features.plugins=false',
    '-c',
    'features.hooks=false',
    '-c',
    'features.codex_hooks=false',
    '-c',
    'notify=[]',
  ];
}

/**
 * Startup `-c` overrides for the generation process: the blankets plus per-name MCP server disables
 * using the correct (possibly quoted) TOML key when the argument is safe for the Windows `.cmd`
 * shim. Names whose quoted key cannot pass the shim's argument guard are still disabled at the
 * thread level (JSON keys carry the exact name).
 */
function startupIsolationCliArgs(mcpNames: readonly string[]): string[] {
  const args = blanketIsolationCliArgs();
  for (const name of mcpNames) {
    const override = `mcp_servers.${tomlKeySegment(name)}.enabled=false`;
    if (!isUnsafeArgument(override)) args.push('-c', override);
  }
  return args;
}

/**
 * Run exactly one text/caller-tool turn against a private ephemeral Codex app-server thread.
 * Native host access, tools, hooks and approvals are disabled; the only tools exposed are the
 * caller's, and a caller tool request is returned to Core without executing it.
 */
export async function runCodexCli(input: CliTransportInput): Promise<CliTurnResult> {
  assertCodexCompatible(input);
  const resolved = resolveOptions(input, input.model, input.options);
  const accountKey: CliAccountKey | null = accountKeyOf(input.connection);
  const environment = input.environment ?? process.env;
  input.signal.throwIfAborted();
  // One overall deadline covers the discovery probe AND the generation turn; no phase gets a fresh
  // timeout budget. Each phase is given whatever time remains on this deadline.
  const overallTimeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + overallTimeoutMs;
  if (overallTimeoutMs <= 0)
    throw new CliTransportError('timeout', 'Codex request deadline already elapsed', {
      accountKey,
    });

  const cwd = await createPrivateWorkingDir();
  let proc: CliProcess | undefined;
  let peer: NdjsonJsonRpcPeer | undefined;
  let settled = false;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  try {
    const executable = await resolveExecutable('codex', input.executable, environment);
    const baseArgs = input.executableArgs ?? [];
    // Discover the native MCP/plugin sources with a non-activating probe, then launch the
    // generation process with the plugin-availability switch and per-name MCP disables already
    // applied at startup, so no inherited MCP/plugin command can run during this turn.
    const isolation = await readNativeIsolationConfig({
      executable,
      baseArgs,
      environment,
      signal: input.signal,
      timeoutMs: deadline - Date.now(),
      accountKey,
    });
    input.signal.throwIfAborted();
    // The single deadline must not be extended: if the probe consumed it, reject before spawning.
    if (Date.now() >= deadline)
      throw new CliTransportError(
        'timeout',
        `Codex request deadline elapsed before generation (${String(overallTimeoutMs)}ms)`,
        { accountKey },
      );
    const inheritedMcpServers = disabledServerOverrides(isolation.mcpNames);
    const inheritedPlugins = disabledPluginOverrides(isolation.plugins);
    const invocation = commandInvocation(executable, [
      ...baseArgs,
      'app-server',
      ...startupIsolationCliArgs(isolation.mcpNames),
    ]);
    proc = spawnCliProcess({
      file: invocation.file,
      args: invocation.args,
      cwd,
      environment: privateChildEnvironment(environment, cwd),
      verbatim: invocation.verbatim,
    });
    const activeProcess: CliProcess = proc;

    let text = '';
    let sawDelta = false;
    let responseModel = input.model.upstreamId;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let latestUsage: TokenBreakdown | null = null;
    const toolCalls: CliTurnToolCall[] = [];
    const { specs, byAlias, aliasByName } = buildToolRoutes(input.tools);

    let resolveDone!: (value: CliTurnResult) => void;
    let rejectDone!: (reason: unknown) => void;
    const done = new Promise<CliTurnResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => undefined);
    const finish = (value: CliTurnResult): void => {
      if (settled) return;
      settled = true;
      resolveDone(value);
    };
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      rejectDone(reason instanceof Error ? reason : new Error(String(reason)));
    };
    const result = (): CliTurnResult => ({
      text,
      toolCalls: [...toolCalls],
      usage: latestUsage ?? emptyTurnUsage(),
      responseModel,
    });

    const handoff = (call: CliTurnToolCall): void => {
      toolCalls.push(call);
      finish(result());
      void (async () => {
        try {
          if (threadId && turnId) await peer?.request('turn/interrupt', { threadId, turnId });
        } catch {
          // The private process is about to be terminated anyway.
        }
        await proc?.killTree();
      })();
    };

    peer = new NdjsonJsonRpcPeer({
      write: (line) => {
        proc?.stdin.write(line);
      },
      onProtocolError: (error) => {
        fail(asCliTransportError(error, 'provider_error'));
      },
      onNotification: (method, params) => {
        const data = isRecord(params) ? params : {};
        switch (method) {
          case 'item/agentMessage/delta': {
            const delta = str(data.delta) ?? '';
            if (delta) {
              sawDelta = true;
              text += delta;
              input.onText?.(delta);
            }
            break;
          }
          case 'item/completed': {
            const item = isRecord(data.item) ? data.item : {};
            if (item.type === 'agentMessage' && !sawDelta) {
              const itemText = str(item.text) ?? '';
              if (itemText) {
                text += itemText;
                input.onText?.(itemText);
              }
            } else if (item.type === 'dynamicToolCall') {
              const id = str(item.id);
              const alias = str(item.tool);
              const tool = alias ? byAlias.get(alias) : undefined;
              // Only Ferry-advertised caller aliases are handed back; a native/unknown tool name is
              // never surfaced to Core as if it were a caller tool.
              if (tool && id && !toolCalls.some((call) => call.id === id)) {
                handoff({
                  id,
                  name: tool.name,
                  arguments: parseToolArguments(item.arguments),
                });
              }
            }
            break;
          }
          case 'thread/tokenUsage/updated': {
            const usage = isRecord(data.tokenUsage) ? data.tokenUsage : {};
            latestUsage = readBreakdown(usage.total) ?? latestUsage;
            break;
          }
          case 'account/rateLimits/updated': {
            if (input.onUsageSnapshot && isRecord(data.rateLimits))
              input.onUsageSnapshot(buildUsageSnapshot(input.connection, data.rateLimits));
            break;
          }
          case 'turn/started': {
            const turn = isRecord(data.turn) ? data.turn : {};
            turnId = str(turn.id) ?? turnId;
            input.onProgress?.();
            break;
          }
          case 'turn/completed': {
            const turn = isRecord(data.turn) ? data.turn : {};
            const status = str(turn.status);
            if (status === 'failed') {
              const error = isRecord(turn.error) ? turn.error : {};
              fail(
                normalizeCodexError(
                  str(error.message) ?? 'Codex turn failed',
                  error.codexErrorInfo,
                  accountKey,
                ),
              );
            } else if (status === 'interrupted') {
              fail(
                new CliTransportError('cancelled', 'Codex turn was interrupted', { accountKey }),
              );
            } else {
              finish(result());
            }
            break;
          }
          case 'error': {
            const error = isRecord(data.error) ? data.error : {};
            fail(
              normalizeCodexError(
                str(error.message) ?? 'Codex reported an error',
                error.codexErrorInfo,
                accountKey,
              ),
            );
            break;
          }
          case 'model/rerouted': {
            const to = str(data.toModel ?? data.model ?? data.newModel);
            if (to && to !== input.model.upstreamId)
              fail(
                new CliTransportError(
                  'provider_error',
                  `Codex rerouted ${input.model.upstreamId} to ${to}; Ferry does not allow silent model substitution`,
                  { accountKey },
                ),
              );
            break;
          }
          default:
            break;
        }
      },
      onServerRequest: (request) => {
        if (request.method === 'item/tool/call') {
          const params = isRecord(request.params) ? request.params : {};
          const id = str(params.callId) ?? `call_${String(request.id)}`;
          const alias = str(params.tool) ?? '';
          const tool = alias ? byAlias.get(alias) : undefined;
          if (!tool) {
            // A native/unknown tool id is not a caller tool; deny it rather than hand it to Core.
            peer?.respondError(
              request.id,
              -32000,
              'Ferry denies native CLI tool calls that are not caller-provided',
            );
            return;
          }
          handoff({
            id,
            name: tool.name,
            arguments: parseToolArguments(params.arguments),
          });
          return;
        }
        // Every other native request (approvals, user input, MCP elicitation, attestation, current
        // time) is denied; the transport never performs host work on the caller's behalf.
        peer?.respondError(request.id, -32000, 'Ferry denies native CLI requests');
      },
    });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => peer?.handleChunk(chunk));

    const request = async (method: string, params: unknown): Promise<unknown> => {
      try {
        return await peer?.request(method, params);
      } catch (error) {
        if (error instanceof JsonRpcRequestError && error.code === -32601)
          throw new CliTransportError(
            'unsupported_capability',
            `Codex app-server does not support ${method}; update the Codex CLI`,
            { accountKey },
          );
        throw asCliTransportError(error, 'provider_error');
      }
    };

    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        aborted = true;
        const error = new CliTransportError('cancelled', 'Codex generation cancelled', {
          accountKey,
        });
        void proc?.killTree();
        reject(error);
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    });

    // The generation phase shares the turn's overall deadline (probe time already elapsed).
    const timeoutMs = Math.max(0, deadline - Date.now());
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void proc?.killTree();
        reject(
          new CliTransportError(
            'timeout',
            `Codex generation timed out after ${String(timeoutMs)}ms`,
            {
              accountKey,
            },
          ),
        );
      }, timeoutMs);
    });

    // Let buffered stdout frames drain before treating an exit as a failure; a CLI that emits its
    // final frame and then exits must still have that frame processed.
    const outputDrained = new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      activeProcess.stdout.once('end', finish);
      activeProcess.stdout.once('close', finish);
      void activeProcess.exited.then(() => {
        setImmediate(() => {
          setImmediate(finish);
        });
      });
    });
    const exitPromise = new Promise<never>((_resolve, reject) => {
      void Promise.all([activeProcess.exited, outputDrained]).then(([exit]) => {
        if (settled || aborted) return;
        const detail = exit.stderr ? redactText(exit.stderr) : '';
        reject(
          new CliTransportError(
            'provider_error',
            `Codex app-server exited before the turn completed${detail ? `: ${detail}` : ''}`,
            { accountKey },
          ),
        );
      });
    });

    const work = (async (): Promise<CliTurnResult> => {
      const initialized = await request('initialize', {
        clientInfo: { name: FERRY_CLIENT_NAME, version: FERRY_CLIENT_VERSION },
        capabilities: { experimentalApi: true },
      });
      const initRecord = isRecord(initialized) ? initialized : {};
      assertCodexVersion(initRecord.userAgent, accountKey);
      peer.notify('initialized', {});

      // Fail closed: confirm the startup blanket switches were actually enforced. A malformed
      // effective config, admin-managed hooks (which Ferry cannot suppress), a surviving notify
      // command, a malformed `plugin/list`, or any plugin still enabled means a native hook/notify/
      // plugin MCP command could run, so reject the turn rather than run without isolation.
      const effective = await request('config/read', {});
      if (!isRecord(effective) || !isRecord(effective.config))
        throw new CliTransportError(
          'unsupported_capability',
          'Codex app-server did not return an effective config; cannot prove native hook/notify isolation. Update the Codex CLI',
          { accountKey },
        );
      if (managedHooksConfigured(effective))
        throw new CliTransportError(
          'unsupported_capability',
          'Codex has admin-managed lifecycle hooks Ferry cannot disable; refusing to run native host commands outside caller permissions. Update the Codex CLI',
          { accountKey },
        );
      if (notifyStillConfigured(effective))
        throw new CliTransportError(
          'unsupported_capability',
          'Codex still has a native notify command configured; cannot disable it for this private run. Update the Codex CLI',
          { accountKey },
        );
      const pluginCheck = checkPluginList(await request('plugin/list', {}));
      if (!pluginCheck.ok)
        throw new CliTransportError(
          'unsupported_capability',
          'Codex app-server returned an unusable plugin/list payload; cannot prove plugin MCP isolation. Update the Codex CLI',
          { accountKey },
        );
      if (pluginCheck.enabledIds.length > 0)
        throw new CliTransportError(
          'unsupported_capability',
          `Codex still exposes enabled plugins (${pluginCheck.enabledIds.join(', ')}); cannot guarantee plugin MCP isolation. Update the Codex CLI`,
          { accountKey },
        );

      const account = await request('account/read', { refreshToken: false });
      assertCodexAccount(account, input.connection, input.model.billing, accountKey);

      if (input.onUsageSnapshot) {
        try {
          const limits = await request('account/rateLimits/read', {});
          if (isRecord(limits) && isRecord(limits.rateLimits))
            input.onUsageSnapshot(buildUsageSnapshot(input.connection, limits.rateLimits));
        } catch {
          // Usage is best-effort and never blocks the turn.
        }
      }

      let serviceTierForTurn = 'default';
      if (resolved.speed === 'fast') {
        if (input.fastServiceTierId) {
          serviceTierForTurn = input.fastServiceTierId;
        } else {
          const listed = await request('model/list', { limit: 100, includeHidden: true });
          const models = isRecord(listed) ? asArray(listed.data) : [];
          const match = models.find(
            (entry) =>
              isRecord(entry) &&
              (str(entry.id) === input.model.upstreamId ||
                str(entry.model) === input.model.upstreamId),
          );
          const tiers = isRecord(match) ? asArray(match.serviceTiers) : [];
          const tier = selectFastTier(tiers);
          if (tier === null)
            throw new CliTransportError(
              'unsupported_capability',
              `Codex advertises no fast service tier for ${input.model.upstreamId}`,
              { accountKey },
            );
          serviceTierForTurn = tier;
        }
      }

      const developerInstructions = buildCodexDeveloperInstructions(input.messages);
      const thread = await request('thread/start', {
        model: input.model.upstreamId,
        cwd,
        ephemeral: true,
        environments: [],
        sandbox: 'read-only',
        approvalPolicy: 'never',
        allowProviderModelFallback: false,
        // Pin the thread's service tier explicitly: 'default' (standard) or the advertised fast
        // tier. Leaving it unset inherits the user's global configured priority/Fast.
        serviceTier: serviceTierForTurn,
        // Replace the native coding/host base prompt with truthful caller-owned instructions, and
        // carry caller system/developer semantics at thread level.
        baseInstructions: buildCodexBaseInstructions(input.messages),
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(specs.length ? { dynamicTools: specs } : {}),
        config: {
          features: {
            shell_tool: false,
            unified_exec: false,
            unified_exec_tty: false,
            shell_snapshot: false,
            view_image: false,
            sleep_tool: false,
            multi_agent: false,
            code_mode: false,
            code_mode_host: false,
            // Belt-and-suspenders with the startup `-c features.*=false` blankets.
            plugins: false,
            hooks: false,
            codex_hooks: false,
          },
          // Hard-disable native web search for this thread regardless of the user's global mode.
          web_search: 'disabled',
          // Clear the native notification command and native lifecycle hooks for this thread.
          notify: [],
          mcp_servers: inheritedMcpServers,
          // Disable every configured plugin (and any declared plugin MCP server) for this thread too.
          plugins: inheritedPlugins,
          // Do not import unrelated native instruction sources (project AGENTS.md, apps,
          // collaboration modes, permissions/environment sections).
          project_doc_max_bytes: 0,
          include_permissions_instructions: false,
          include_apps_instructions: false,
          include_collaboration_mode_instructions: false,
          include_environment_context: false,
        },
      });
      const threadRecord = isRecord(thread) ? thread : {};
      const threadObject = isRecord(threadRecord.thread) ? threadRecord.thread : {};
      threadId = str(threadObject.id) ?? str(threadRecord.threadId);
      if (!threadId)
        throw new CliTransportError('provider_error', 'Codex did not return a thread id', {
          accountKey,
        });
      responseModel = str(threadRecord.model) ?? str(threadObject.model) ?? responseModel;

      const last = input.messages.at(-1);
      const historyMessages = last?.role === 'user' ? input.messages.slice(0, -1) : input.messages;
      const items = conversationItems(historyMessages, aliasByName);
      let inputItems: unknown[] = [];
      let toolOutput: Record<string, unknown> | null = null;
      if (last?.role === 'user') {
        inputItems = [{ type: 'text', text: last.content ?? '' }];
      } else if (last?.role === 'tool') {
        const call = [...input.messages]
          .reverse()
          .flatMap((message) => message.tool_calls ?? [])
          .find((entry) => entry.id === last.tool_call_id);
        toolOutput = {
          name: call ? (aliasByName.get(call.function.name) ?? call.function.name) : 'tool',
          output: last.content ?? '',
        };
      } else if (items.length === 0) {
        inputItems = [{ type: 'text', text: serializeConversation(input.messages) }];
      }

      if (items.length) {
        try {
          await request('thread/inject_items', { threadId, items });
        } catch (error) {
          if (error instanceof CliTransportError && error.kind === 'unsupported_capability') {
            inputItems = [{ type: 'text', text: serializeConversation(input.messages) }];
            toolOutput = null;
          } else {
            throw error;
          }
        }
      }

      const started = await request('turn/start', {
        threadId,
        input: inputItems,
        model: input.model.upstreamId,
        serviceTierForTurn,
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(toolOutput ? { toolOutput } : {}),
      });
      const startedRecord = isRecord(started) ? started : {};
      const startedTurn = isRecord(startedRecord.turn) ? startedRecord.turn : {};
      turnId = str(startedTurn.id) ?? turnId;
      input.onProgress?.();
      return await done;
    })();

    return await Promise.race([work, abortPromise, timeoutPromise, exitPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener('abort', onAbort);
    peer?.close();
    await proc?.killTree();
    await removePrivateWorkingDir(cwd);
  }
}
