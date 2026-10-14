import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { CliAccountKey, CliConnection, CliUsageSnapshot, CliUsageWindow } from '@ferry/shared';
import { CliTransportError, asCliTransportError } from './errors.js';
import { isRecord, asArray, str, num } from './coerce.js';
import {
  commandInvocation,
  createPrivateWorkingDir,
  removePrivateWorkingDir,
  resolveExecutable,
  spawnCliProcess,
  type CliProcess,
} from './process.js';
import { redactText } from './redact.js';
import {
  assertClaudeCompatible,
  accountKeyOf,
  normalizePlan,
  plansMatch,
  resolveOptions,
} from './validate.js';
import { openZenToolBridge } from '../zen-tools.js';
import {
  emptyTurnUsage,
  type CliConversationMessage,
  type CliTurnResult,
  type CliTurnToolCall,
  type CliTurnUsage,
  type CliTransportInput,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MCP_SERVER_NAME = 'ferry_tools';
const BUILTIN_TOOLS_DENIED = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
];

function normalizeClaudeError(
  message: string,
  accountKey: string | null,
  statusCode?: number,
): CliTransportError {
  const lower = message.toLowerCase();
  const details = statusCode === undefined ? { accountKey } : { accountKey, statusCode };
  if (
    /usage limit|usage_limit_reached|out of (?:extra )?usage|credits? (?:depleted|exhausted)/.test(
      lower,
    )
  )
    return new CliTransportError('exhausted_capacity', message, details);
  if (statusCode === 429 || /rate limit|rate_limit|429|overloaded|try again/.test(lower))
    return new CliTransportError('temporary_rate_limit', message, details);
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthor|not logged in|sign in|authentication/.test(lower)
  )
    return new CliTransportError('authentication', message, details);
  if (statusCode === 404 || /model not found|unknown model|unavailable model/.test(lower))
    return new CliTransportError('unavailable_model', message, details);
  return new CliTransportError('provider_error', message, details);
}

/**
 * Normalize one Claude usage object. Anthropic's `input_tokens` excludes cache, so the input total
 * is input + cache_read + cache_creation when those components are reported; a source that already
 * reports a `total_input_tokens` is used as-is (no double counting). Cached stays cache_read, and
 * reasoning is preserved from `output_tokens_details.thinking_tokens` when reported.
 */
function normalizeClaudeUsage(source: Record<string, unknown>): CliTurnUsage {
  const input = num(source.input_tokens);
  const cacheRead = num(source.cache_read_input_tokens);
  const cacheCreate = num(source.cache_creation_input_tokens);
  const combined = num(source.total_input_tokens);
  let inputTokens: number | null;
  if (combined !== null) inputTokens = combined;
  else if (input === null && cacheRead === null && cacheCreate === null) inputTokens = null;
  else inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);
  const details = isRecord(source.output_tokens_details) ? source.output_tokens_details : null;
  const reasoning = details ? num(details.thinking_tokens) : null;
  return {
    inputTokens,
    outputTokens: num(source.output_tokens),
    cachedTokens: cacheRead,
    reasoningTokens: reasoning ?? num(source.reasoning_tokens),
  };
}

/**
 * Confirm the CURRENT native sign-in before dispatch. A successful `initialize` alone is not proof
 * of sign-in; `claude auth status --json` is the bounded, read-only source of truth.
 */
async function assertClaudeAuthStatus(
  executable: string,
  executableArgs: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  connection: CliConnection,
  accountKey: string | null,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const invocation = commandInvocation(executable, [...executableArgs, 'auth', 'status', '--json']);
  let stdout: string;
  try {
    const result = await execa(invocation.file, invocation.args, {
      cwd,
      env: environment,
      extendEnv: false,
      reject: false,
      windowsHide: true,
      timeout: 10_000,
      cancelSignal: signal,
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    if (result.failed) {
      if (signal.aborted)
        throw new CliTransportError('cancelled', 'Claude auth check cancelled', { accountKey });
      throw new CliTransportError(
        'authentication',
        `Could not confirm Claude sign-in (auth status failed): ${redactText(result.stderr || result.stdout)}`,
        { accountKey },
      );
    }
    stdout = result.stdout;
  } catch (error) {
    if (error instanceof CliTransportError) throw error;
    if (signal.aborted)
      throw new CliTransportError('cancelled', 'Claude auth check cancelled', { accountKey });
    throw new CliTransportError('authentication', 'Could not run Claude auth status', {
      accountKey,
    });
  }
  let status: unknown;
  try {
    status = JSON.parse(stdout.trim());
  } catch {
    throw new CliTransportError(
      'authentication',
      'Claude auth status did not return JSON; sign in again',
      { accountKey },
    );
  }
  if (!isRecord(status))
    throw new CliTransportError('authentication', 'Claude auth status was empty', { accountKey });
  if (status.loggedIn !== true)
    throw new CliTransportError('authentication', 'Claude is not signed in', { accountKey });
  const provider = str(status.apiProvider);
  if (provider !== null && provider !== 'firstParty')
    throw new CliTransportError(
      'authentication',
      `Claude is authenticated via ${provider}, not the supplied first-party subscription connection`,
      { accountKey },
    );
  if (str(status.apiKeySource) !== null)
    throw new CliTransportError(
      'authentication',
      'Claude is authenticated with an API key rather than the supplied subscription account; refresh the connection',
      { accountKey },
    );
  assertClaudePlan(str(status.subscriptionType), connection, accountKey);
  return status;
}

function assertClaudePlan(
  statusPlanValue: string | null,
  connection: CliConnection,
  accountKey: string | null,
): void {
  const statusPlan = normalizePlan(statusPlanValue);
  const suppliedPlan = normalizePlan(connection.account.plan);
  if (statusPlan !== null && suppliedPlan !== null && !plansMatch(statusPlan, suppliedPlan))
    throw new CliTransportError(
      'authentication',
      `Claude subscription "${statusPlan}" no longer matches the supplied connection plan "${suppliedPlan}"; refresh the connection`,
      { accountKey },
    );
}

/** Validate the initialize account against the supplied connection (identity/source). */
function assertClaudeInitAccount(
  initialized: Record<string, unknown>,
  connection: CliConnection,
  accountKey: string | null,
): void {
  const account = isRecord(initialized.account) ? initialized.account : null;
  if (!account) return;
  const provider = str(account.apiProvider);
  if (provider !== null && provider !== 'firstParty')
    throw new CliTransportError(
      'authentication',
      `Claude is authenticated via ${provider}, not the supplied first-party subscription connection`,
      { accountKey },
    );
  if (str(account.apiKeySource) !== null)
    throw new CliTransportError(
      'authentication',
      'Claude is authenticated with an API key rather than the supplied subscription account',
      { accountKey },
    );
  assertClaudePlan(str(account.subscriptionType), connection, accountKey);
  const email = str(account.email)?.trim().toLowerCase() ?? null;
  const suppliedLabel = connection.account.label?.trim().toLowerCase() ?? null;
  if (
    email !== null &&
    suppliedLabel !== null &&
    suppliedLabel.includes('@') &&
    email !== suppliedLabel
  )
    throw new CliTransportError(
      'authentication',
      'Claude signed-in account differs from the supplied connection; refresh the connection',
      { accountKey },
    );
}

function claudeWindows(source: Record<string, unknown>): CliUsageWindow[] {
  const rateLimits = isRecord(source.rate_limits) ? source.rate_limits : null;
  const windows: CliUsageWindow[] = [];
  const addWindow = (id: string, label: string, raw: unknown): void => {
    if (!isRecord(raw)) return;
    const rawUtilization = num(raw.utilization);
    if (rawUtilization === null) return;
    // get_usage reports percentages 0..100; streamed events report fractions. Normalize both.
    const fraction = rawUtilization > 1 ? rawUtilization / 100 : rawUtilization;
    const resetsAt =
      str(raw.resets_at) ??
      (num(raw.resetsAt) !== null ? new Date((num(raw.resetsAt) ?? 0) * 1000).toISOString() : null);
    windows.push({
      id,
      label,
      metric: 'percent',
      windowKind: 'rolling',
      used: rawUtilization,
      limit: 100,
      remaining: Math.max(0, 100 - rawUtilization),
      utilization: fraction,
      resetAt: resetsAt,
    });
  };
  if (rateLimits) {
    addWindow('five_hour', '5-hour window', rateLimits.five_hour);
    addWindow('seven_day', '7-day window', rateLimits.seven_day);
    addWindow('seven_day_opus', '7-day Opus window', rateLimits.seven_day_opus);
    addWindow('seven_day_sonnet', '7-day Sonnet window', rateLimits.seven_day_sonnet);
  }
  return windows;
}

function buildUsageSnapshot(
  connection: CliConnection,
  source: Record<string, unknown>,
): CliUsageSnapshot | null {
  const windows = claudeWindows(source);
  if (windows.length === 0) return null;
  return {
    connectionId: connection.id,
    accountKey: connection.account.key,
    state: 'available',
    source: 'claude-code control get_usage',
    observedAt: new Date().toISOString(),
    staleAt: null,
    windows,
    note: null,
  };
}

interface InputFrame {
  type: string;
  message?: Record<string, unknown>;
  request_id?: string;
  request?: Record<string, unknown>;
  /** History echoed to the model; `false`/absent marks the live prompt turn. */
  isReplay?: boolean;
}

/** Translate the caller conversation into Claude stream-json input frames, preserving roles/ids. */
function buildConversationFrames(
  messages: readonly CliConversationMessage[],
  claudeNameByName: Map<string, string>,
): { frames: InputFrame[]; preamble: string } {
  const frames: InputFrame[] = [];
  const preambleParts: string[] = [];
  for (const message of messages) {
    const text = message.content ?? '';
    if (message.role === 'system' || message.role === 'developer') {
      preambleParts.push(`[${message.role}]\n${text}`);
      continue;
    }
    if (message.role === 'assistant') {
      const content: Record<string, unknown>[] = [];
      if (text) content.push({ type: 'text', text });
      for (const call of message.tool_calls ?? [])
        content.push({
          type: 'tool_use',
          id: call.id,
          name: claudeNameByName.get(call.function.name) ?? call.function.name,
          input: safeJson(call.function.arguments),
        });
      if (content.length)
        frames.push({ type: 'assistant', message: { role: 'assistant', content } });
      continue;
    }
    if (message.role === 'tool') {
      frames.push({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id ?? '',
              content: text,
            },
          ],
        },
      });
      continue;
    }
    frames.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }
  return { frames, preamble: preambleParts.join('\n\n') };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  return {};
}

/**
 * Run one text/caller-tool turn against a private Claude Code stream/control invocation. Built-in
 * tools, external MCP, plugins, hooks and slash commands are disabled; only the caller's tools are
 * exposed through an authenticated local bridge, and a caller tool request is handed back to Core.
 */
export async function runClaudeCodeCli(input: CliTransportInput): Promise<CliTurnResult> {
  assertClaudeCompatible(input);
  const resolved = resolveOptions(input, input.model, input.options);
  const accountKey: CliAccountKey | null = accountKeyOf(input.connection);
  const environment = input.environment ?? process.env;
  input.signal.throwIfAborted();

  const cwd = await createPrivateWorkingDir();
  let proc: CliProcess | undefined;
  let bridge: Awaited<ReturnType<typeof openZenToolBridge>> | undefined;
  let settled = false;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  try {
    // Caller tools are exposed only through the authenticated local MCP bridge.
    bridge = input.tools.length > 0 ? await openZenToolBridge(input.tools) : undefined;
    const mcpConfig = {
      mcpServers: bridge
        ? {
            [MCP_SERVER_NAME]: {
              type: 'http',
              url: bridge.url,
              headers: { Authorization: `Bearer ${bridge.token}` },
            },
          }
        : {},
    };
    const settings = {
      disableAllHooks: true,
      permissions: {
        deny: BUILTIN_TOOLS_DENIED,
        ...(bridge ? { allow: [`mcp__${MCP_SERVER_NAME}`] } : {}),
      },
      fastMode: resolved.speed === 'fast',
      fastModePerSessionOptIn: true,
    };
    const mcpConfigPath = join(cwd, 'mcp-config.json');
    const settingsPath = join(cwd, 'settings.json');
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
    await writeFile(settingsPath, JSON.stringify(settings), 'utf8');

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfigPath,
      '--settings',
      settingsPath,
      '--disable-slash-commands',
      '--model',
      input.model.upstreamId,
      // Pin the effective reasoning effort so a native/global configured effort never leaks in.
      ...(resolved.effort ? ['--effort', resolved.effort] : []),
    ];
    const executable = await resolveExecutable('claude', input.executable, environment);
    // Confirm the current native sign-in/source from bounded read-only status JSON BEFORE any
    // generation process is started or any prompt is sent.
    await assertClaudeAuthStatus(
      executable,
      input.executableArgs ?? [],
      cwd,
      environment,
      input.connection,
      accountKey,
      input.signal,
    );
    const invocation = commandInvocation(executable, [...(input.executableArgs ?? []), ...args]);
    proc = spawnCliProcess({
      file: invocation.file,
      args: invocation.args,
      cwd,
      environment,
      verbatim: invocation.verbatim,
    });
    const activeProcess: CliProcess = proc;
    proc.stderr.on('data', () => undefined); // Stderr may carry credentials/provider text.

    let text = '';
    let sawStreamEvent = false;
    let responseModel = input.model.upstreamId;
    // The most recent single usage object from any source. Sources are cumulative, so the last one
    // wins (result over stream/assistant) and snapshots are never summed.
    let latestUsage: Record<string, unknown> | null = null;
    const toolCalls: CliTurnToolCall[] = [];
    const claudeNameByName = new Map<string, string>();
    input.tools.forEach((tool, index) => {
      if (!claudeNameByName.has(tool.name))
        claudeNameByName.set(tool.name, `mcp__${MCP_SERVER_NAME}__tool_${String(index)}`);
    });

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
      usage: latestUsage ? normalizeClaudeUsage(latestUsage) : emptyTurnUsage(),
      responseModel,
    });

    const controlPending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let controlSeq = 0;
    const writeFrame = (frame: Record<string, unknown>): void => {
      try {
        proc?.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        fail(asCliTransportError(error, 'provider_error'));
      }
    };
    const controlRequest = (
      subtype: string,
      payload: Record<string, unknown> = {},
    ): Promise<unknown> => {
      const request_id = `ferry_ctl_${String(++controlSeq)}`;
      return new Promise<unknown>((resolve, reject) => {
        controlPending.set(request_id, { resolve, reject });
        writeFrame({ type: 'control_request', request_id, request: { subtype, ...payload } });
      });
    };

    const handoff = (call: CliTurnToolCall): void => {
      toolCalls.push(call);
      finish(result());
      void proc?.killTree();
    };

    const toolFromClaudeName = (
      name: string,
    ): { tool: CliTransportInput['tools'][number]; index: number } | null => {
      const prefix = `mcp__${MCP_SERVER_NAME}__tool_`;
      if (!name.startsWith(prefix)) return null;
      const index = Number(name.slice(prefix.length));
      const tool = input.tools[index];
      if (tool === undefined) return null;
      return { tool, index };
    };

    // Streaming tool_use blocks arrive as content_block_start(input:{}) + input_json_delta fragments
    // + content_block_stop. Never settle on the empty start block; accumulate by block index and
    // only hand off once the JSON is complete. Duplicate sources for the same id are deduped.
    interface StreamingToolBlock {
      id: string;
      name: string;
      json: string;
    }
    const streamingBlocks = new Map<number, StreamingToolBlock>();
    const handledToolIds = new Set<string>();

    const completeToolCall = (
      id: string | null,
      name: string | null,
      args: Record<string, unknown>,
    ): void => {
      if (!id || !name) {
        fail(
          new CliTransportError('provider_error', 'Claude returned an incomplete tool call', {
            accountKey,
          }),
        );
        return;
      }
      if (handledToolIds.has(id)) return;
      const matched = toolFromClaudeName(name);
      if (!matched) {
        fail(
          new CliTransportError(
            'unsupported_capability',
            `Claude requested a non-caller tool (${name}); Ferry will not run native tools`,
            { accountKey },
          ),
        );
        return;
      }
      handledToolIds.add(id);
      handoff({ id, name: matched.tool.name, arguments: args });
    };

    const finalizeBlock = (index: number): void => {
      const block = streamingBlocks.get(index);
      if (!block) return;
      streamingBlocks.delete(index);
      const raw = block.json.trim();
      if (raw === '') {
        completeToolCall(
          block.id === '' ? null : block.id,
          block.name === '' ? null : block.name,
          {},
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail(
          new CliTransportError('provider_error', 'Claude sent invalid tool arguments', {
            accountKey,
          }),
        );
        return;
      }
      if (!isRecord(parsed)) {
        fail(
          new CliTransportError('provider_error', 'Claude sent invalid tool arguments', {
            accountKey,
          }),
        );
        return;
      }
      completeToolCall(
        block.id === '' ? null : block.id,
        block.name === '' ? null : block.name,
        parsed,
      );
    };

    const handleFrame = (frame: unknown): void => {
      if (!isRecord(frame)) return;
      const type = str(frame.type);
      if (type === 'control_response') {
        const response = isRecord(frame.response) ? frame.response : {};
        const requestId = str(response.request_id);
        if (!requestId) return;
        const pending = controlPending.get(requestId);
        if (!pending) return;
        controlPending.delete(requestId);
        if (str(response.subtype) === 'error')
          pending.reject(new Error(str(response.error) ?? 'Claude control request failed'));
        else pending.resolve(response.response);
        return;
      }
      if (type === 'control_request') {
        const request = isRecord(frame.request) ? frame.request : {};
        const requestId = str(frame.request_id);
        if (str(request.subtype) === 'can_use_tool') {
          const toolName = str(request.tool_name);
          const toolUseId = str(request.tool_use_id);
          const matched = toolName ? toolFromClaudeName(toolName) : null;
          if (matched) {
            if (toolUseId && handledToolIds.has(toolUseId)) return;
            if (!isRecord(request.input)) {
              fail(
                new CliTransportError(
                  'provider_error',
                  'Claude returned incomplete tool arguments',
                  { accountKey },
                ),
              );
              return;
            }
            completeToolCall(toolUseId, toolName, request.input);
            return;
          }
        }
        // Any other control request (hooks, non-caller tools) is denied.
        if (requestId)
          writeFrame({
            type: 'control_response',
            response: {
              request_id: requestId,
              subtype: 'error',
              error: 'Ferry denies native control requests',
            },
          });
        return;
      }
      if (type === 'stream_event') {
        const event = isRecord(frame.event) ? frame.event : {};
        const eventType = str(event.type);
        if (eventType === 'content_block_start') {
          const block = isRecord(event.content_block) ? event.content_block : {};
          if (str(block.type) === 'tool_use') {
            // Do not hand off here: `input` is an empty placeholder until the deltas complete.
            const index = num(event.index) ?? -1;
            streamingBlocks.set(index, {
              id: str(block.id) ?? '',
              name: str(block.name) ?? '',
              json: '',
            });
          }
        } else if (eventType === 'content_block_delta') {
          const delta = isRecord(event.delta) ? event.delta : {};
          const deltaType = str(delta.type);
          if (deltaType === 'text_delta') {
            const chunk = str(delta.text) ?? '';
            if (chunk) {
              sawStreamEvent = true;
              text += chunk;
              input.onText?.(chunk);
            }
          } else if (deltaType === 'input_json_delta') {
            const index = num(event.index) ?? -1;
            const block = streamingBlocks.get(index);
            if (block) block.json += str(delta.partial_json) ?? '';
          }
        } else if (eventType === 'content_block_stop') {
          finalizeBlock(num(event.index) ?? -1);
        }
        if (isRecord(event.usage)) latestUsage = event.usage;
        else if (isRecord(event.message) && isRecord(event.message.usage))
          latestUsage = event.message.usage;
        return;
      }
      if (type === 'assistant') {
        const message = isRecord(frame.message) ? frame.message : {};
        responseModel = str(message.model) ?? responseModel;
        if (isRecord(message.usage)) latestUsage = message.usage;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const item of content) {
          if (!isRecord(item)) continue;
          if (str(item.type) === 'tool_use') {
            const id = str(item.id);
            if (id && handledToolIds.has(id)) continue;
            if (!isRecord(item.input)) {
              fail(
                new CliTransportError(
                  'provider_error',
                  'Claude returned incomplete tool arguments',
                  { accountKey },
                ),
              );
              return;
            }
            completeToolCall(id, str(item.name), item.input);
          } else if (str(item.type) === 'text' && !sawStreamEvent) {
            const chunk = str(item.text) ?? '';
            if (chunk) {
              text += chunk;
              input.onText?.(chunk);
            }
          }
        }
        return;
      }
      if (type === 'rate_limit_event') {
        const info = isRecord(frame.rate_limit_info) ? frame.rate_limit_info : {};
        if (input.onUsageSnapshot) {
          const snapshot = buildUsageSnapshot(input.connection, {
            rate_limits: {
              five_hour: {
                utilization: num(info.utilization),
                resets_at: num(info.resetsAt),
              },
            },
          });
          if (snapshot) input.onUsageSnapshot(snapshot);
        }
        return;
      }
      if (type === 'result') {
        const subtype = str(frame.subtype);
        if (isRecord(frame.usage)) latestUsage = frame.usage;
        if (frame.is_error === true || (subtype?.startsWith('error') ?? false)) {
          const message = str(frame.result) ?? `Claude turn failed (${subtype ?? 'error'})`;
          fail(normalizeClaudeError(message, accountKey));
          return;
        }
        if (!text && typeof frame.result === 'string') text = frame.result;
        finish(result());
        return;
      }
    };

    let lineBuffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      lineBuffer += chunk;
      for (;;) {
        const end = lineBuffer.indexOf('\n');
        if (end < 0) break;
        const line = lineBuffer.slice(0, end);
        lineBuffer = lineBuffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          handleFrame(JSON.parse(line));
        } catch {
          // Ignore non-JSON noise on stdout.
        }
      }
    });

    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        aborted = true;
        const error = new CliTransportError('cancelled', 'Claude generation cancelled', {
          accountKey,
        });
        void proc?.killTree();
        reject(error);
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    });

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void proc?.killTree();
        reject(
          new CliTransportError(
            'timeout',
            `Claude generation timed out after ${String(timeoutMs)}ms`,
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
            `Claude exited before the turn completed${detail ? `: ${detail}` : ''}`,
            { accountKey },
          ),
        );
      });
    });

    const work = (async (): Promise<CliTurnResult> => {
      const initialized = await controlRequest('initialize');
      if (isRecord(initialized)) {
        const models = asArray(initialized.models);
        const match = models.find(
          (entry) =>
            isRecord(entry) &&
            (str(entry.resolvedModel) === input.model.upstreamId ||
              str(entry.value) === input.model.upstreamId),
        );
        if (models.length > 0 && !match)
          throw new CliTransportError(
            'unavailable_model',
            `Claude does not offer ${input.model.upstreamId}`,
            { accountKey },
          );
        if (resolved.speed === 'fast' && isRecord(match) && match.supportsFastMode === false)
          throw new CliTransportError(
            'unsupported_capability',
            `Fast mode is disabled for ${input.model.upstreamId}`,
            { accountKey },
          );
        assertClaudeInitAccount(initialized, input.connection, accountKey);
      }

      if (input.onUsageSnapshot) {
        try {
          const usageResult = await controlRequest('get_usage');
          if (isRecord(usageResult)) {
            const snapshot = buildUsageSnapshot(input.connection, usageResult);
            if (snapshot) input.onUsageSnapshot(snapshot);
          }
        } catch {
          // Usage is best-effort and never blocks the turn.
        }
      }

      const { frames, preamble } = buildConversationFrames(input.messages, claudeNameByName);
      if (preamble) {
        const first = frames.find((frame) => frame.type === 'user');
        if (first && isRecord(first.message) && Array.isArray(first.message.content)) {
          (first.message.content as unknown[]).unshift({ type: 'text', text: preamble });
        } else {
          frames.unshift({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: preamble }] },
          });
        }
      }
      // History frames are replayed context; the final frame is the live prompt. Keeping stdin open
      // lets the CLI emit control requests (e.g. tool permission) that the transport can answer.
      frames.forEach((frame, index) => {
        frame.isReplay = index !== frames.length - 1;
      });
      for (const frame of frames) writeFrame(frame as unknown as Record<string, unknown>);
      input.onProgress?.();
      return await done;
    })();

    return await Promise.race([work, abortPromise, timeoutPromise, exitPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener('abort', onAbort);
    await bridge?.close();
    await proc?.killTree();
    await removePrivateWorkingDir(cwd);
  }
}
