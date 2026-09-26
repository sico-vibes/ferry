import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ClientConnection,
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { DelegationRunSchema, LaneSchema, newId } from '@ferry/shared';
import type { DelegationRun, FileChange, Lane, SessionId } from '@ferry/shared';
import type { BriefingSection } from '@ferry/router';

export type Implementer = 'codex' | 'opencode' | 'claude' | 'acp';
export type NativeLane = Omit<Lane, 'source' | 'trusted'> & {
  permission: 'read_only' | 'scoped_write';
  paths: string[];
};
export interface LaneReadOptions {
  workspacePath: string;
  ferryLanes?: readonly NativeLane[];
  approvedProjectHash?: string | null;
  environment?: NodeJS.ProcessEnv;
  gitRoot?: (workspacePath: string) => Promise<string | null>;
}
export interface LaneReadResult {
  lanes: Lane[];
  projectHash: string | null;
  projectConfigPath: string | null;
}
interface FleetFile {
  version?: unknown;
  lanes?: unknown;
}

const defaultGitRoot = async (workspacePath: string): Promise<string | null> => {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspacePath,
      reject: false,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};
const hashText = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const readOptional = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

function lanesFromText(text: string, source: 'global' | 'project', trusted: boolean): Lane[] {
  let data: FleetFile;
  try {
    data = JSON.parse(text) as FleetFile;
  } catch {
    return [];
  }
  if (data.version !== 'delegate-fleet.v1' || typeof data.lanes !== 'object' || data.lanes === null)
    return [];
  const lanes: Lane[] = [];
  for (const [name, raw] of Object.entries(data.lanes)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (!['codex', 'opencode', 'claude', 'acp', 'ferry'].includes(String(entry.implementer)))
      continue;
    const lane = LaneSchema.safeParse({
      name,
      implementer: entry.implementer,
      agent: typeof entry.agent === 'string' ? entry.agent : null,
      transport: entry.transport === 'acp' ? 'acp' : 'native',
      ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
      ...(Array.isArray(entry.args)
        ? { args: entry.args.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(typeof entry.env === 'object' && entry.env !== null
        ? {
            env: Object.fromEntries(
              Object.entries(entry.env).filter(
                (pair): pair is [string, string] => typeof pair[1] === 'string',
              ),
            ),
          }
        : {}),
      profile: typeof entry.profile === 'string' ? entry.profile : null,
      model: typeof entry.model === 'string' ? entry.model : null,
      effort: typeof entry.effort === 'string' ? entry.effort : null,
      variant: typeof entry.variant === 'string' ? entry.variant : null,
      permission:
        entry.permission === 'read_only' || entry.permission === 'scoped_write'
          ? entry.permission
          : null,
      paths: Array.isArray(entry.paths)
        ? entry.paths.filter((value): value is string => typeof value === 'string')
        : [],
      source,
      trusted,
    });
    if (lane.success) lanes.push(lane.data);
  }
  return lanes;
}

/** Read fleet files without ever writing them. A project file is trusted only for its exact approved bytes. */
export async function readLanes(options: LaneReadOptions): Promise<LaneReadResult> {
  const environment = options.environment ?? process.env;
  const configHome = environment.XDG_CONFIG_HOME
    ? resolve(environment.XDG_CONFIG_HOME)
    : join(environment.USERPROFILE ?? environment.HOME ?? homedir(), '.config');
  const globalPath = join(configHome, 'delegate-skills', 'config.json');
  const globalText = await readOptional(globalPath);
  const root = await (options.gitRoot ?? defaultGitRoot)(options.workspacePath);
  const projectConfigPath = root ? join(root, '.delegate', 'config.json') : null;
  const projectText = projectConfigPath ? await readOptional(projectConfigPath) : null;
  const projectHash = projectText === null ? null : hashText(projectText);
  const lanes = [
    ...(globalText === null ? [] : lanesFromText(globalText, 'global', true)),
    ...(projectText === null
      ? []
      : lanesFromText(projectText, 'project', projectHash === options.approvedProjectHash)),
    ...(options.ferryLanes ?? []).map((lane) =>
      LaneSchema.parse({ ...lane, source: 'ferry', trusted: true }),
    ),
  ];
  return { lanes, projectHash, projectConfigPath };
}

export interface BriefInput {
  goal: string;
  currentState?: string;
  scope?: string[];
  doNotTouch?: string[];
  interfaces?: string[];
  acceptance?: string[];
  gates?: readonly string[];
  projectConfig?: { gateCommands?: readonly string[] };
  reportContract?: string[];
}
export interface EditableBrief {
  sections: BriefingSection[];
  text: string;
}
export function buildDelegationBrief(input: BriefInput): EditableBrief {
  const sections: BriefingSection[] = [
    { title: 'Goal', content: input.goal },
    { title: 'Current state', content: input.currentState ?? '' },
    { title: 'Scope', content: (input.scope ?? []).map((item) => `- ${item}`).join('\n') },
    {
      title: 'Do-not-touch',
      content: (input.doNotTouch ?? []).map((item) => `- ${item}`).join('\n'),
    },
    {
      title: 'Interfaces',
      content: (input.interfaces ?? []).map((item) => `- ${item}`).join('\n'),
    },
    {
      title: 'Acceptance',
      content: (input.acceptance ?? []).map((item) => `- ${item}`).join('\n'),
    },
    {
      title: 'Gates',
      content: (input.gates ?? input.projectConfig?.gateCommands ?? [])
        .map((item) => `- ${item}`)
        .join('\n'),
    },
    { title: 'Commit policy', content: 'Do not commit.' },
    {
      title: 'Report contract',
      content: (
        input.reportContract ?? [
          'Summary',
          'Files changed',
          'Decisions and deviations',
          'Full gate output',
        ]
      )
        .map((item) => `- ${item}`)
        .join('\n'),
    },
  ];
  return {
    sections,
    text: sections.map(({ title, content }) => `## ${title}\n${content}`).join('\n\n'),
  };
}

export interface AdapterRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  variant?: string;
  mode?: 'build' | 'plan';
  resumeId?: string;
  timeoutMs?: number;
  executable?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  permissionPolicy?: 'read_only' | 'scoped_write';
  paths?: string[];
  checkpoint?: () => Promise<void>;
  requestApproval?: (request: {
    title: string;
    command: string;
    permissionPolicy: 'read_only' | 'scoped_write';
  }) => Promise<boolean>;
  onAuthMethods?: (methods: readonly { id: string; name: string }[]) => void;
  authMethodId?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}
export interface AdapterResult {
  finalMessage: string;
  threadId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    provider: 'subscription_cli';
  };
  progress: string[];
  artifactsDir: string;
}
export interface CliDetection {
  available: boolean;
  authenticated: boolean;
  version: string | null;
  executable: string | null;
  error?: string;
}
export interface AcpAgentDefinition {
  id: string;
  name: string;
  command: string;
  args: readonly string[];
  detectArgs: readonly string[];
  installHint: string;
  supportsModel: boolean;
  supportsMode: boolean;
  launchVerified: boolean;
  verified: boolean;
  verifiedAt: string | null;
  caution: boolean;
  cautionNote: string | null;
}
export const ACP_AGENT_REGISTRY: readonly AcpAgentDefinition[] = [
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp'],
    detectArgs: ['--version'],
    installHint: 'Install Gemini CLI.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: true,
    verified: true,
    verifiedAt: '2026-09-25',
    caution: false,
    cautionNote: null,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude-code-acp',
    args: [],
    detectArgs: ['--version'],
    installHint: 'Install the Claude Code ACP adapter.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex-acp',
    args: [],
    detectArgs: ['--version'],
    installHint: 'Install a Codex ACP adapter.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: true,
    verifiedAt: '2026-09-25',
    caution: false,
    cautionNote: null,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    detectArgs: ['--version'],
    installHint: 'Install OpenCode with ACP support.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: true,
    verified: true,
    verifiedAt: '2026-09-25',
    caution: false,
    cautionNote: null,
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    command: 'qwen',
    args: ['--experimental-acp'],
    detectArgs: ['--version'],
    installHint: 'Install Qwen Code and check the current ACP flag.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
  {
    id: 'kimi-cli',
    name: 'Kimi CLI',
    command: 'kimi',
    args: ['acp'],
    detectArgs: ['--version'],
    installHint: 'Install Kimi CLI with ACP support.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    command: 'vibe',
    args: ['--acp'],
    detectArgs: ['--version'],
    installHint: 'Install Mistral Vibe and verify its ACP flag.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    args: ['acp'],
    detectArgs: ['--version'],
    installHint: 'Install Goose with ACP support.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    args: ['--acp'],
    detectArgs: ['--version'],
    installHint: 'Install GitHub Copilot CLI and verify its ACP option.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    command: 'kiro-cli',
    args: ['acp'],
    detectArgs: ['--version'],
    installHint: 'Install Kiro CLI with ACP support.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: true,
    cautionNote: 'Kiro terms ban third-party harness use; accounts have been banned',
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    args: ['--acp'],
    detectArgs: ['--version'],
    installHint: 'Install Cline and verify its ACP mode.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi-acp',
    args: [],
    detectArgs: ['--version'],
    installHint: 'Install Pi and the pi-free extension yourself, then install pi-acp.',
    supportsModel: false,
    supportsMode: false,
    launchVerified: false,
    verified: false,
    verifiedAt: null,
    caution: false,
    cautionNote: null,
  },
];
export const ACP_AGENT_SUGGESTIONS = ACP_AGENT_REGISTRY.filter((agent) => !agent.caution);
export interface DetectedAcpAgent extends AcpAgentDefinition {
  available: boolean;
  version: string | null;
  executable: string | null;
  error?: string;
}
export async function detectAcpAgents(
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<DetectedAcpAgent[]> {
  return await Promise.all(ACP_AGENT_REGISTRY.map((agent) => detectAcpAgent(agent.id, options)));
}
export async function detectAcpAgent(
  id: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<DetectedAcpAgent> {
  const agent = ACP_AGENT_REGISTRY.find((entry) => entry.id === id);
  if (!agent) throw new Error(`Unknown ACP agent: ${id}`);
  try {
    const executable = await executablePath(agent.command);
    const invocation = commandInvocation(executable, [...agent.detectArgs]);
    const result = await execa(invocation.file, invocation.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      reject: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? 10_000,
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    return {
      ...agent,
      available: !result.failed,
      version: result.failed ? null : result.stdout.trim() || result.stderr.trim() || null,
      executable,
      ...(result.failed ? { error: result.stderr || 'Version probe failed' } : {}),
    };
  } catch (error) {
    return {
      ...agent,
      available: false,
      version: null,
      executable: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export function resolveAcpCommand(executable: string, args: string[]) {
  assertSafeArguments(args);
  return commandInvocation(executable, args);
}
export function assertSafeArguments(args: readonly string[]): void {
  for (const arg of args) {
    const standaloneOperator =
      !arg.includes('\n') && /(?:;\s|\s&&\s|\s\|\s|\s\|\|\s|\s[<>^%!]\s)/.test(arg);
    if (arg.includes('\0') || standaloneOperator)
      throw new Error(`Unsafe CLI argument rejected: ${arg}`);
  }
}

function cliArgs(name: Implementer, request: AdapterRequest, outputPath: string): string[] {
  const args: string[] = [];
  if (name === 'codex') {
    args.push('exec');
    if (request.resumeId) args.push('resume', request.resumeId);
    args.push('--json', '-o', outputPath);
    if (request.model) args.push('-m', request.model);
    if (request.effort) args.push('-c', `model_reasoning_effort=${request.effort}`);
    args.push(
      '--sandbox',
      request.mode === 'plan' ? 'read-only' : 'workspace-write',
      '--cd',
      request.cwd,
      '-',
    );
  } else if (name === 'opencode') {
    args.push('run');
    if (request.resumeId) args.push('--session', request.resumeId);
    if (request.model) args.push('--model', request.model);
    if (request.mode) args.push('--agent', request.mode);
    if (request.variant) args.push('--variant', request.variant);
    if (request.mode === 'build') args.push('--yolo');
    args.push('--format', 'json');
  } else {
    args.push('-p', '--output-format', 'stream-json', '--verbose');
    if (request.model) args.push('--model', request.model);
    if (request.resumeId) args.push('--resume', request.resumeId);
    args.push('--permission-mode', request.mode === 'plan' ? 'plan' : 'acceptEdits');
  }
  assertSafeArguments(args);
  return args;
}

function parseEvent(
  name: Implementer,
  event: Record<string, unknown>,
  state: {
    threadId: string | null;
    final: string;
    input: number;
    output: number;
    cost: number | null;
  },
  onProgress: (text: string) => void,
): void {
  if (name === 'codex') {
    if (typeof event.thread_id === 'string') state.threadId = event.thread_id;
    const item =
      typeof event.item === 'object' && event.item !== null
        ? (event.item as Record<string, unknown>)
        : null;
    const text =
      item?.type === 'command_execution' && typeof item.command === 'string'
        ? `Command: ${item.command}`
        : '';
    if (text) onProgress(text);
    const usage = event.usage as Record<string, unknown> | undefined;
    if (usage) {
      state.input += Number(usage.input_tokens ?? 0);
      state.output += Number(usage.output_tokens ?? 0);
    }
    const content = item?.content;
    if (Array.isArray(content))
      state.final = content
        .map((part) => {
          if (typeof part !== 'object' || part === null) return '';
          const value = part as Record<string, unknown>;
          return typeof value.text === 'string' ? value.text : '';
        })
        .join('');
  } else if (name === 'opencode') {
    if (typeof event.sessionID === 'string') state.threadId = event.sessionID;
    const part = event.part as Record<string, unknown> | undefined;
    if (event.type === 'tool' && typeof event.tool === 'string') onProgress(`Tool: ${event.tool}`);
    if (event.type === 'text' && typeof part?.text === 'string') state.final += part.text;
    const tokens = event.tokens as Record<string, unknown> | undefined;
    if (tokens) {
      state.input += Number(tokens.input ?? 0);
      state.output += Number(tokens.output ?? 0);
    }
  } else {
    if (typeof event.session_id === 'string') state.threadId = event.session_id;
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (event.type === 'assistant' && Array.isArray(content)) {
      for (const block of content)
        if (typeof block === 'object' && block !== null) {
          const value = block as Record<string, unknown>;
          if (value.type === 'text' && typeof value.text === 'string') {
            state.final += value.text;
            onProgress(value.text);
          }
        }
    }
    if (event.type === 'result') {
      if (typeof event.result === 'string') state.final = event.result;
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        state.input += Number(usage.input_tokens ?? 0);
        state.output += Number(usage.output_tokens ?? 0);
      }
      if (typeof event.total_cost_usd === 'number') state.cost = event.total_cost_usd;
    }
  }
}

async function executablePath(name: string, custom?: string): Promise<string> {
  if (custom) return custom;
  const command = name;
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      for (const suffix of ['.cmd', '.exe', '.bat']) {
        const candidate = join(dir, `${command}${suffix}`);
        try {
          await access(candidate);
          return candidate;
        } catch {
          /* try next shim */
        }
      }
    }
  }
  return command;
}

async function execute(
  name: Implementer,
  args: string[],
  request: AdapterRequest,
  onProgress: (text: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  const executable = await executablePath(name, request.executable);
  const invocation = commandInvocation(executable, args);
  const launchFile = invocation.file;
  const launchArgs = invocation.args;
  const command = execa(launchFile, launchArgs, {
    cwd: request.cwd,
    reject: false,
    windowsHide: true,
    buffer: false,
    ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  command.stdin.end(request.prompt);
  let stdout = '';
  let stderr = '';
  let stdoutTail = '';
  command.stdout.setEncoding('utf8');
  command.stderr.setEncoding('utf8');
  command.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    const rows = `${stdoutTail}${chunk}`.split(/\r?\n/);
    stdoutTail = rows.pop() ?? '';
    for (const line of rows) if (line.trim()) onProgress(line);
  });
  command.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timeout = request.timeoutMs ?? 10 * 60_000;
  const killTree = async () => {
    if (process.platform === 'win32' && command.pid !== undefined) {
      const killed = await execa('taskkill.exe', ['/pid', String(command.pid), '/T', '/F'], {
        reject: false,
        windowsHide: true,
      });
      if (!killed.failed) return;
    }
    command.kill('SIGTERM');
  };
  let killInFlight: Promise<void> | null = null;
  const onAbort = () => {
    killInFlight = killTree();
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  let timer: NodeJS.Timeout | undefined;
  const watchdog = { timedOut: false };
  try {
    const outcome = await Promise.race([
      command,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          watchdog.timedOut = true;
          void killTree().finally(() => {
            reject(new Error(`Delegate timed out after ${String(timeout)}ms`));
          });
        }, timeout);
      }),
    ]);
    if (watchdog.timedOut) throw new Error(`Delegate timed out after ${String(timeout)}ms`);
    if (stdoutTail.trim()) onProgress(stdoutTail);
    if (outcome.failed)
      throw new Error(stderr || `CLI exited with code ${String(outcome.exitCode)}`);
    return { stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
    await Promise.resolve(killInFlight);
  }
}

function acpUpdateText(update: import('@agentclientprotocol/sdk').SessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' ? update.content.text : '';
    case 'agent_thought_chunk':
      return update.content.type === 'text' ? `Thought: ${update.content.text}` : '';
    case 'tool_call':
      return `Tool: ${update.title}`;
    case 'tool_call_update':
      return `Tool update: ${update.status ?? 'running'}`;
    case 'plan':
      return `Plan: ${update.entries.map((entry) => entry.content).join('; ')}`;
    case 'plan_update':
      return `Plan updated: ${JSON.stringify(update.plan)}`;
    case 'usage_update':
      return `Usage: ${String(update.used)}/${String(update.size)}${update.cost ? ` · ${String(update.cost.amount)} ${update.cost.currency}` : ''}`;
    default:
      return JSON.stringify(update);
  }
}

async function runAcpAdapter(request: AdapterRequest): Promise<AdapterResult> {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'ferry-delegate-acp-'));
  const executable = await executablePath('acp', request.executable);
  const args = request.args ?? [];
  assertSafeArguments(args);
  const invocation = commandInvocation(executable, args);
  const child = execa(invocation.file, invocation.args, {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    reject: false,
    windowsHide: true,
    buffer: false,
    ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  child.stderr.on('data', (chunk: Buffer) =>
    request.onProgress?.(`ACP: ${chunk.toString('utf8').trimEnd()}`),
  );
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const progress: string[] = [];
  let final = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let threadId: string | null = null;
  let connection: ClientConnection | undefined;
  let killInFlight: Promise<void> | undefined;
  const killTree = async () => {
    if (process.platform === 'win32' && child.pid !== undefined) {
      const result = await execa('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        reject: false,
        windowsHide: true,
        timeout: 2_000,
      });
      if (result.failed) child.kill('SIGKILL');
    } else child.kill('SIGTERM');
  };
  const onAbort = () => {
    if (connection && threadId)
      void connection.agent
        .notify('session/cancel', { sessionId: threadId })
        .catch(() => undefined);
    killInFlight = killTree();
  };
  const report = (text: string) => {
    if (!text) return;
    progress.push(text);
    request.onProgress?.(text);
  };
  const client = acpClient({ name: 'Ferry' })
    .onRequest('fs/read_text_file', async ({ params }) => {
      const safePath = await assertAcpWorkspacePath(request.cwd, params.path, false);
      return { content: await readFile(safePath, 'utf8') };
    })
    .onRequest('fs/write_text_file', async ({ params }) => {
      const safePath = await assertAcpWorkspacePath(request.cwd, params.path, true);
      const allowed =
        request.permissionPolicy !== 'read_only' &&
        (!request.paths?.length ||
          request.paths.some((path) =>
            delegatePaths.isWithin(resolve(request.cwd, path), safePath),
          ));
      if (!allowed) throw new Error('ACP file write denied by the lane permission policy');
      await request.checkpoint?.();
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(resolve(safePath, '..'), { recursive: true });
      await writeFile(safePath, params.content, 'utf8');
      return {};
    })
    .onRequest('session/request_permission', async ({ params }) => {
      const allowed = request.requestApproval
        ? await request.requestApproval({
            title: params.toolCall.title ?? 'ACP agent permission request',
            command: params.toolCall.rawInput
              ? JSON.stringify(params.toolCall.rawInput)
              : (params.toolCall.title ?? 'ACP agent permission request'),
            permissionPolicy: request.permissionPolicy ?? 'read_only',
          })
        : request.permissionPolicy === 'scoped_write';
      const option = params.options.find(
        (item) => item.kind === (allowed ? 'allow_once' : 'reject_once'),
      );
      return option
        ? { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' as const } };
    })
    .onNotification('session/update', ({ params }) => {
      const message = acpUpdateText(params.update);
      if (
        params.update.sessionUpdate === 'agent_message_chunk' &&
        'content' in params.update &&
        params.update.content.type === 'text'
      )
        final += params.update.content.text;
      if (params.update.sessionUpdate === 'usage_update') {
        const usage = params.update as {
          inputTokens?: number;
          outputTokens?: number;
          costUsd?: number;
        };
        inputTokens = usage.inputTokens ?? inputTokens;
        outputTokens = usage.outputTokens ?? outputTokens;
        costUsd = usage.costUsd ?? costUsd;
      }
      report(message);
    });
  const timeout = request.timeoutMs ?? 10 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  request.signal?.addEventListener('abort', onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  try {
    const activeConnection = client.connect(stream);
    connection = activeConnection;
    const work = (async () => {
      const initialized = await activeConnection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'Ferry', version: '0.1.0' },
      });
      const methods = (initialized.authMethods ?? []).map((method) => ({
        id: method.id,
        name: method.name,
      }));
      request.onAuthMethods?.(methods);
      if (methods.length) {
        if (!request.authMethodId)
          throw new Error(
            `ACP authentication required. Available methods: ${methods.map((method) => `${method.id} (${method.name})`).join(', ')}`,
          );
        await activeConnection.agent.request('authenticate', { methodId: request.authMethodId });
      }
      let activeSessionId: string;
      let modes: SessionModeState | null | undefined;
      let configOptions: SessionConfigOption[] | null | undefined;
      if (request.resumeId) {
        const resumed = await activeConnection.agent.request('session/resume', {
          sessionId: request.resumeId,
          cwd: resolve(request.cwd),
          mcpServers: [],
        });
        activeSessionId = request.resumeId;
        modes = resumed.modes;
        configOptions = resumed.configOptions;
      } else {
        const created = await activeConnection.agent.request('session/new', {
          cwd: resolve(request.cwd),
          mcpServers: [],
        });
        activeSessionId = created.sessionId;
        modes = created.modes;
        configOptions = created.configOptions;
      }
      threadId = activeSessionId;
      if (request.mode && modes?.availableModes) {
        const wanted = request.mode.toLowerCase();
        const mode = modes.availableModes.find(
          (item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted,
        );
        if (mode)
          await activeConnection.agent.request('session/set_mode', {
            sessionId: activeSessionId,
            modeId: mode.id,
          });
      }
      if (request.model && configOptions) {
        const modelOption = configOptions.find(
          (option) =>
            option.type === 'select' && (option.category === 'model' || /model/i.test(option.id)),
        );
        if (modelOption?.type === 'select') {
          const options = modelOption.options.flatMap((item) =>
            'options' in item ? item.options : [item],
          );
          const selected = options.find(
            (item) => item.value === request.model || item.name === request.model,
          );
          if (selected)
            await activeConnection.agent.request('session/set_config_option', {
              sessionId: activeSessionId,
              configId: modelOption.id,
              type: 'select',
              value: selected.value,
            });
        }
      }
      const response = await activeConnection.agent.request('session/prompt', {
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text: request.prompt }],
      });
      const usage = response.usage as
        { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
      if (usage) {
        inputTokens = usage.inputTokens ?? inputTokens;
        outputTokens = usage.outputTokens ?? outputTokens;
        costUsd = usage.costUsd ?? costUsd;
      }
      activeConnection.close();
      await killTree();
    })();
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void killTree();
          reject(new Error(`Delegate timed out after ${String(timeout)}ms`));
        }, timeout);
      }),
    ]);
    return {
      finalMessage: final || 'Delegate completed without a final message.',
      threadId,
      usage: { inputTokens, outputTokens, costUsd, provider: 'subscription_cli' },
      progress,
      artifactsDir,
    };
  } catch (error) {
    const outcome = await Promise.race([
      child,
      new Promise<null>((resolveOutcome) =>
        setTimeout(() => {
          resolveOutcome(null);
        }, 150),
      ),
    ]);
    if (!outcome) await killTree();
    await rm(artifactsDir, { recursive: true, force: true });
    if (outcome?.failed) {
      throw new Error(`ACP agent exited with code ${String(outcome.exitCode)}`, { cause: error });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
    await Promise.resolve(killInFlight);
    connection?.close();
  }
}

function quoteCmdArgument(argument: string): string {
  return `"${argument.replaceAll('"', '""')}"`;
}

function commandInvocation(
  executable: string,
  args: string[],
): {
  file: string;
  args: string[];
  verbatim: boolean;
} {
  const isShim =
    process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase());
  return isShim
    ? {
        file: process.env.ComSpec ?? 'cmd.exe',
        args: [
          '/d',
          '/s',
          '/c',
          `"${quoteCmdArgument(executable)} ${args.map(quoteCmdArgument).join(' ')}"`,
        ],
        verbatim: true,
      }
    : { file: executable, args, verbatim: false };
}

export async function detectCli(
  name: Implementer,
  options: { executable?: string; cwd?: string; timeoutMs?: number; checkAuth?: boolean } = {},
): Promise<CliDetection> {
  const executable = await executablePath(name, options.executable);
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    const versionInvocation = commandInvocation(executable, ['--version']);
    const version = await execa(versionInvocation.file, versionInvocation.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      reject: false,
      windowsHide: true,
      timeout: timeoutMs,
      ...(versionInvocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    if (version.failed)
      return {
        available: false,
        authenticated: false,
        version: null,
        executable,
        error: version.stderr || 'Version probe failed',
      };
    if (options.checkAuth === false)
      return {
        available: true,
        authenticated: false,
        version: version.stdout.trim() || null,
        executable,
      };
    const authArgs =
      name === 'codex'
        ? ['login', 'status']
        : name === 'opencode'
          ? ['auth', 'list']
          : ['auth', 'status'];
    const authInvocation = commandInvocation(executable, authArgs);
    const auth = await execa(authInvocation.file, authInvocation.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      reject: false,
      windowsHide: true,
      timeout: timeoutMs,
      ...(authInvocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    return {
      available: true,
      authenticated: !auth.failed,
      version: version.stdout.trim() || null,
      executable,
    };
  } catch (error) {
    return {
      available: false,
      authenticated: false,
      version: null,
      executable,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runAdapter(
  name: Implementer,
  request: AdapterRequest,
): Promise<AdapterResult> {
  if (name === 'acp') return await runAcpAdapter(request);
  const artifactsDir = await mkdtemp(join(tmpdir(), 'ferry-delegate-'));
  const outputPath = join(artifactsDir, 'codex-final.txt');
  const raw: string[] = [];
  const state = {
    threadId: null as string | null,
    final: '',
    input: 0,
    output: 0,
    cost: null as number | null,
  };
  const progress = (text: string) => {
    raw.push(text);
    request.onProgress?.(text);
  };
  try {
    const args = cliArgs(name, request, outputPath);
    await execute(name, args, request, (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        progress(line);
        return;
      }
      if (typeof event === 'object' && event !== null)
        parseEvent(name, event as Record<string, unknown>, state, progress);
    });
    if (name === 'codex') {
      const saved = await readOptional(outputPath);
      if (saved) state.final = saved;
    }
    return {
      finalMessage: state.final || 'Delegate completed without a final message.',
      threadId: state.threadId,
      usage: {
        inputTokens: state.input,
        outputTokens: state.output,
        costUsd: state.cost,
        provider: 'subscription_cli',
      },
      progress: raw,
      artifactsDir,
    };
  } catch (error) {
    await rm(artifactsDir, { recursive: true, force: true });
    throw error;
  }
}

export interface StartDelegationInput {
  runId?: DelegationRun['id'];
  sessionId: SessionId;
  lane: Lane;
  brief: string;
  cwd: string;
  timeoutMs?: number;
  checkpointDiff: () => Promise<FileChange[]>;
  checkpoint?: () => Promise<void>;
  requestApproval?: AdapterRequest['requestApproval'];
  onAuthMethods?: AdapterRequest['onAuthMethods'];
  authMethodId?: string;
  onUpdate?: (run: DelegationRun) => void;
}
export interface DelegationHandle {
  run: Promise<DelegationRun>;
  cancel(): void;
  resume(brief: string): Promise<DelegationRun>;
}
export function startDelegation(input: StartDelegationInput): DelegationHandle {
  const controller = new AbortController();
  const runId = input.runId ?? (newId('run') as DelegationRun['id']);
  const run: DelegationRun = DelegationRunSchema.parse({
    id: runId,
    sessionId: input.sessionId,
    lane: input.lane.name,
    implementer: input.lane.implementer,
    brief: input.brief,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: [],
    finalMessage: null,
    touchedFiles: [],
    gateResults: [],
    usage: null,
    decision: null,
  });
  let threadId: string | null = null;
  const update = (text?: string) => {
    if (text) run.progress.push({ at: new Date().toISOString(), text });
    input.onUpdate?.(structuredClone(run));
  };
  const runPromise = (async () => {
    try {
      const acpEnabled = input.lane.implementer === 'acp' || input.lane.transport === 'acp';
      const acpAgentId =
        input.lane.agent ??
        (['codex', 'opencode', 'claude'].includes(input.lane.implementer)
          ? input.lane.implementer
          : null);
      const acpAgent =
        acpEnabled && acpAgentId
          ? ACP_AGENT_REGISTRY.find(
              (item) =>
                item.id === acpAgentId || (acpAgentId === 'claude' && item.id === 'claude-code'),
            )
          : undefined;
      if (acpEnabled && !acpAgent)
        throw new Error(`Unknown ACP agent: ${input.lane.agent ?? '(missing)'}`);
      const result = await runAdapter(
        acpEnabled ? 'acp' : (input.lane.implementer as Implementer),
        {
          prompt: input.brief,
          cwd: input.cwd,
          ...(acpAgent ? { executable: acpAgent.command, args: [...acpAgent.args] } : {}),
          ...(input.lane.command ? { executable: input.lane.command } : {}),
          ...(input.lane.args ? { args: [...input.lane.args] } : {}),
          ...(input.lane.env ? { env: input.lane.env } : {}),
          permissionPolicy: input.lane.permission ?? 'read_only',
          paths: input.lane.paths,
          ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
          ...(input.requestApproval ? { requestApproval: input.requestApproval } : {}),
          ...(input.onAuthMethods ? { onAuthMethods: input.onAuthMethods } : {}),
          ...(input.authMethodId ? { authMethodId: input.authMethodId } : {}),
          ...(input.lane.model ? { model: input.lane.model } : {}),
          ...(input.lane.effort ? { effort: input.lane.effort } : {}),
          ...(input.lane.variant ? { variant: input.lane.variant } : {}),
          mode: input.lane.permission === 'read_only' ? 'plan' : 'build',
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          signal: controller.signal,
          onProgress: (text) => {
            update(text);
          },
        },
      );
      threadId = result.threadId;
      run.status = 'completed';
      run.finalMessage = result.finalMessage;
      run.usage = result.usage;
      run.touchedFiles = await input.checkpointDiff();
      run.finishedAt = new Date().toISOString();
      update();
      return run;
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      run.finalMessage = error instanceof Error ? error.message : String(error);
      run.finishedAt = new Date().toISOString();
      update();
      return run;
    }
  })();
  return {
    run: runPromise,
    cancel() {
      controller.abort();
    },
    async resume(brief: string) {
      if (!threadId) throw new Error('Cannot resume before the CLI returns a session id');
      const resumeAcp = input.lane.implementer === 'acp' || input.lane.transport === 'acp';
      const resumeAgentId =
        input.lane.agent ??
        (['codex', 'opencode', 'claude'].includes(input.lane.implementer)
          ? input.lane.implementer
          : null);
      const resumeAgent =
        resumeAcp && resumeAgentId
          ? ACP_AGENT_REGISTRY.find(
              (item) =>
                item.id === resumeAgentId ||
                (resumeAgentId === 'claude' && item.id === 'claude-code'),
            )
          : undefined;
      const resumed = await runAdapter(
        resumeAcp ? 'acp' : (input.lane.implementer as Implementer),
        {
          prompt: brief,
          cwd: input.cwd,
          ...(resumeAgent ? { executable: resumeAgent.command, args: [...resumeAgent.args] } : {}),
          ...(input.lane.command ? { executable: input.lane.command } : {}),
          ...(input.lane.args ? { args: [...input.lane.args] } : {}),
          ...(input.lane.env ? { env: input.lane.env } : {}),
          permissionPolicy: input.lane.permission ?? 'read_only',
          paths: input.lane.paths,
          resumeId: threadId,
          ...(input.lane.model ? { model: input.lane.model } : {}),
          ...(input.lane.effort ? { effort: input.lane.effort } : {}),
          ...(input.lane.variant ? { variant: input.lane.variant } : {}),
          mode: input.lane.permission === 'read_only' ? 'plan' : 'build',
          signal: controller.signal,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          onProgress: (text) => {
            update(text);
          },
        },
      );
      run.brief = brief;
      run.finalMessage = resumed.finalMessage;
      run.usage = resumed.usage;
      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      run.touchedFiles = await input.checkpointDiff();
      update();
      return structuredClone(run);
    },
  };
}

export interface DecisionDependencies {
  restoreCheckpoint?: () => Promise<void>;
  resumeSession?: (deltaBrief: string) => Promise<DelegationRun>;
}
export async function decide(
  run: DelegationRun,
  decision: 'accepted' | 'rejected' | 'rework',
  deltaBrief?: string,
  dependencies: DecisionDependencies = {},
): Promise<DelegationRun> {
  if (decision === 'rejected') {
    if (!dependencies.restoreCheckpoint)
      throw new Error('Rejecting a run requires a checkpoint restore callback');
    await dependencies.restoreCheckpoint();
  }
  if (decision === 'rework') {
    if (!deltaBrief?.trim()) throw new Error('Rework requires a delta brief');
    if (!dependencies.resumeSession)
      throw new Error('Rework requires a CLI session resume callback');
    const resumed = await dependencies.resumeSession(deltaBrief);
    run.brief = `${run.brief}\n\n## Rework\n${deltaBrief}`;
    run.progress = [...run.progress, ...resumed.progress];
    run.finalMessage = resumed.finalMessage;
    run.usage = resumed.usage;
    run.touchedFiles = resumed.touchedFiles;
    run.status = resumed.status;
    run.finishedAt = resumed.finishedAt;
  }
  run.decision = decision;
  return run;
}

export const delegatePaths = {
  normalize: (path: string) => resolve(path),
  isWithin: (root: string, path: string) => {
    const base = resolve(root);
    const target = resolve(base, path);
    const pathFromRoot = relative(base, target);
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
  },
};

async function assertAcpWorkspacePath(
  workspace: string,
  target: string,
  writing: boolean,
): Promise<string> {
  const root = await realpath(resolve(workspace));
  const absolute = resolve(target);
  if (!delegatePaths.isWithin(root, absolute))
    throw new Error('ACP file path escapes the delegation workspace');
  let probe = absolute;
  for (;;) {
    try {
      const actual = await realpath(probe);
      if (!delegatePaths.isWithin(root, actual))
        throw new Error('ACP file path escapes the delegation workspace through a symlink');
      if (writing && probe !== absolute) return absolute;
      return actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = resolve(probe, '..');
      if (parent === probe)
        throw new Error('ACP file path has no existing workspace parent', { cause: error });
      probe = parent;
    }
  }
}
