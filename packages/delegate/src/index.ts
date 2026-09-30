import { createHash } from 'node:crypto';
import { isProtectedWorkspacePath, summarizeAgentEvent } from '@ferry/shared';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { execa } from 'execa';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ClientConnection,
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { DelegationRunSchema, LaneSchema, newId } from '@ferry/shared';
import {
  canonicalizePath,
  hasWindowsDrivePrefix,
  normalizePathSeparators,
} from '@ferry/shared/node-paths';
import type { AgentEvent, DelegationRun, FileChange, Lane, SessionId } from '@ferry/shared';
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
  opencodeEnvironment?: NodeJS.ProcessEnv;
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

function stripJsonComments(source: string): string {
  let output = '';
  let quoted = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
        output += character;
      } else output += ' ';
    } else if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        output += '  ';
        index += 1;
      } else output += character === '\n' || character === '\r' ? character : ' ';
    } else if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      output += character;
    } else if (character === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      output += '  ';
      index += 1;
    } else output += character;
  }
  let json = '';
  quoted = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index] ?? '';
    if (quoted) {
      json += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      json += character;
    } else if (character === ',') {
      let next = index + 1;
      while (/\s/.test(output[next] ?? '')) next += 1;
      if (output[next] !== '}' && output[next] !== ']') json += character;
    } else json += character;
  }
  return json;
}

function configuredOpenCodeModel(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(text));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === 'string' && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

async function configuredModelFromFile(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return configuredOpenCodeModel(text);
  } catch {
    return null;
  }
}

/** Resolve the user/project OpenCode default from config files only; never inspect auth stores. */
export async function readOpenCodeDefaultModel(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const home = environment.USERPROFILE ?? environment.HOME ?? homedir();
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, '.config');
  let model: string | null = null;
  const readConfig = async (base: string, name: string) => {
    for (const extension of ['.json', '.jsonc']) {
      const next = await configuredModelFromFile(join(base, `${name}${extension}`));
      if (next) model = next;
    }
  };
  await readConfig(join(configHome, 'opencode'), 'opencode');
  if (environment.OPENCODE_CONFIG) {
    const customConfig = resolve(cwd, environment.OPENCODE_CONFIG);
    const customModel = await configuredModelFromFile(customConfig);
    if (customModel) model = customModel;
  }
  const directories = [resolve(cwd)];
  let cursor = directories[0] ?? resolve(cwd);
  let foundGitRoot = false;
  while (dirname(cursor) !== cursor) {
    try {
      await access(join(cursor, '.git'));
      foundGitRoot = true;
      break;
    } catch {
      const parent = dirname(cursor);
      directories.push(parent);
      cursor = parent;
    }
  }
  if (foundGitRoot) {
    for (const directory of directories.reverse()) await readConfig(directory, 'opencode');
  } else {
    await readConfig(resolve(cwd), 'opencode');
  }
  if (environment.OPENCODE_CONFIG_CONTENT) {
    const inlineModel = configuredOpenCodeModel(environment.OPENCODE_CONFIG_CONTENT);
    if (inlineModel) model = inlineModel;
  }
  return model;
}

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
    ? canonicalizePath(resolve(environment.XDG_CONFIG_HOME))
    : canonicalizePath(join(environment.USERPROFILE ?? environment.HOME ?? homedir(), '.config'));
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
  if (lanes.some((lane) => lane.implementer === 'opencode' && !lane.model?.trim())) {
    const model = await readOpenCodeDefaultModel(
      options.workspacePath,
      options.opencodeEnvironment ?? process.env,
    );
    if (model)
      return {
        lanes: lanes.map((lane) =>
          lane.implementer === 'opencode' && !lane.model?.trim() ? { ...lane, model } : lane,
        ),
        projectHash,
        projectConfigPath,
      };
  }
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
  promptFilePath?: string;
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
  onEvent?: (event: AgentEvent) => void;
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
  events: AgentEvent[];
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

function boundEventOutput(event: AgentEvent, artifactsDir: string): AgentEvent {
  if (event.type !== 'tool_result' || event.output.length <= 16_000) return event;
  const recoveryHandle = join(artifactsDir, `${event.id}.txt`);
  void writeFile(recoveryHandle, event.output, 'utf8').catch(() => undefined);
  return {
    ...event,
    output: `${event.output.slice(0, 16_000)}\n[Output truncated]`,
    truncated: true,
    recoveryHandle,
  };
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
    const shellSyntax = /[\0\r\n%!'"`]/.test(arg) || /\$\([^)]*\)|%[^%]+%/.test(arg);
    if (shellSyntax) throw new Error(`Unsafe CLI argument rejected: ${arg}`);
  }
}

export function buildCliArgs(
  name: Implementer,
  request: AdapterRequest,
  outputPath: string,
  codexVersion?: string,
): string[] {
  const args: string[] = [...(request.args ?? [])];
  if (name === 'codex') {
    args.push('exec');
    if (request.resumeId && usesCodexResumeV159Syntax(codexVersion)) {
      args.push(
        'resume',
        '--json',
        '--output-last-message',
        outputPath,
        request.resumeId,
        request.prompt,
      );
      assertSafeArguments(args);
      return args;
    }
    if (request.resumeId) args.push('resume', request.resumeId);
    args.push('--json', '-o', outputPath);
    if (request.model) args.push('-m', request.model);
    if (request.effort) args.push('-c', `model_reasoning_effort=${request.effort}`);
    // Codex 0.159+ resumes returned above. New sessions and known pre-0.159 resumes take
    // --sandbox/--cd; an unknown-version resume omits them (newer CLIs reject them and the
    // resumed session keeps its original sandbox).
    const knownCodexVersion = /codex-cli\s+\d+\.\d+\.\d+/i.test(codexVersion ?? '');
    if (!request.resumeId || knownCodexVersion)
      args.push(
        '--sandbox',
        request.mode === 'plan' ? 'read-only' : 'workspace-write',
        '--cd',
        request.cwd,
      );
    args.push('-');
  } else if (name === 'opencode') {
    args.push('run');
    if (request.resumeId) args.push('--session', request.resumeId);
    if (request.model) args.push('--model', request.model);
    if (request.mode) args.push('--agent', request.mode);
    if (request.variant) args.push('--variant', request.variant);
    if (!request.promptFilePath) throw new Error('OpenCode prompt file path is required');
    args.push('--file', request.promptFilePath, '--dir', request.cwd);
    if (request.mode === 'build') args.push('--auto');
    args.push('--format', 'json', 'Follow the task in the attached brief file.');
  } else {
    args.push('-p', '--output-format', 'stream-json', '--verbose');
    if (request.model) args.push('--model', request.model);
    if (request.resumeId) args.push('--resume', request.resumeId);
    args.push('--permission-mode', request.mode === 'plan' ? 'plan' : 'acceptEdits');
  }
  assertSafeArguments(args);
  return args;
}

function usesCodexResumeV159Syntax(versionOutput: string | undefined): boolean {
  const match = versionOutput?.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  return (
    (version[0] ?? 0) > 0 ||
    ((version[0] ?? 0) === 0 &&
      ((version[1] ?? 0) > 159 || ((version[1] ?? 0) === 159 && (version[2] ?? 0) >= 0)))
  );
}

async function readCliVersion(name: Implementer, request: AdapterRequest): Promise<string | null> {
  try {
    const executable = await executablePath(name, request.executable);
    const invocation = commandInvocation(executable, ['--version']);
    const result = await execa(invocation.file, invocation.args, {
      cwd: request.cwd,
      reject: false,
      windowsHide: true,
      timeout: 10_000,
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    return result.failed ? null : result.stdout.trim();
  } catch {
    return null;
  }
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1 || pid === process.pid)
    return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isTaskkillNotFound(exitCode: number | undefined, output: string): boolean {
  return exitCode === 128 && /not found|no running instance/i.test(output);
}

function valueString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

export function mapCliEvent(name: Implementer, event: Record<string, unknown>): AgentEvent[] {
  const at = new Date().toISOString();
  const make = (value: Record<string, unknown>): AgentEvent =>
    ({ ...value, id: newId('event'), timestamp: at }) as AgentEvent;
  const text = (type: 'text' | 'thinking', content: unknown): AgentEvent[] =>
    typeof content === 'string' && content.length ? [make({ type, content })] : [];
  if (name === 'codex') {
    const item =
      typeof event.item === 'object' && event.item !== null
        ? (event.item as Record<string, unknown>)
        : {};
    const type = valueString(event.type);
    const kind = valueString(item.type);
    if (type === 'item.agentMessage.delta') return text('text', event.delta);
    if (type === 'item.completed' && kind === 'agentMessage' && Array.isArray(item.content))
      return item.content.flatMap((raw) =>
        raw && typeof raw === 'object' ? text('text', (raw as Record<string, unknown>).text) : [],
      );
    if (type.includes('reasoning') && type.endsWith('.delta')) return text('thinking', event.delta);
    if (
      type === 'item.started' &&
      ['commandExecution', 'command_execution', 'mcpToolCall', 'mcp_tool_call'].includes(kind)
    )
      return [
        make({
          type: 'tool_use',
          callId: valueString(item.id, newId('call')),
          tool: kind.startsWith('command') ? 'shell' : valueString(item.tool, 'tool'),
          input: item.command ?? item.arguments ?? {},
        }),
      ];
    if (
      type === 'item.completed' &&
      ['commandExecution', 'command_execution', 'mcpToolCall', 'mcp_tool_call'].includes(kind)
    )
      return [
        make({
          type: 'tool_result',
          callId: valueString(item.id, newId('call')),
          output: valueString(item.aggregatedOutput ?? item.result),
          truncated: item.outputTruncated === true,
        }),
      ];
    if (type === 'turn.completed' && typeof event.usage === 'object' && event.usage !== null) {
      const usage = event.usage as Record<string, unknown>;
      return [
        make({
          type: 'usage',
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
        }),
      ];
    }
    return [];
  }
  if (name === 'opencode') {
    const part =
      typeof event.part === 'object' && event.part !== null
        ? (event.part as Record<string, unknown>)
        : {};
    const kind = valueString(event.type);
    if (kind === 'text') return text('text', part.text ?? event.text);
    if (kind === 'reasoning') return text('thinking', part.text ?? event.text);
    const state =
      typeof part.state === 'object' && part.state !== null
        ? (part.state as Record<string, unknown>)
        : {};
    const callId = valueString(part.callID ?? part.id ?? event.callID, newId('call'));
    if (kind === 'tool')
      return state.status === 'completed' || state.status === 'error'
        ? [
            make({
              type: 'tool_result',
              callId,
              output: valueString(state.output ?? state.error),
              truncated: state.truncated === true,
            }),
          ]
        : [
            make({
              type: 'tool_use',
              callId,
              tool: valueString(part.tool ?? event.tool, 'tool'),
              input: state.input ?? {},
            }),
          ];
    if (
      (kind === 'step_finish' || kind === 'step-finish') &&
      typeof event.tokens === 'object' &&
      event.tokens !== null
    ) {
      const tokens = event.tokens as Record<string, unknown>;
      return [
        make({
          type: 'usage',
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
        }),
      ];
    }
    if (kind === 'error')
      return [
        make({
          type: 'error',
          message: valueString(event.message ?? event.error, 'OpenCode error'),
        }),
      ];
    return [];
  }
  const message =
    typeof event.message === 'object' && event.message !== null
      ? (event.message as Record<string, unknown>)
      : {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const result: AgentEvent[] = [];
  if (event.type === 'stream_event' && typeof event.event === 'object' && event.event !== null) {
    const streamEvent = event.event as Record<string, unknown>;
    const delta =
      typeof streamEvent.delta === 'object' && streamEvent.delta !== null
        ? (streamEvent.delta as Record<string, unknown>)
        : {};
    if (delta.type === 'text_delta') result.push(...text('text', delta.text));
    else if (delta.type === 'thinking_delta') result.push(...text('thinking', delta.thinking));
    else if (
      streamEvent.type === 'content_block_start' &&
      typeof streamEvent.content_block === 'object' &&
      streamEvent.content_block !== null
    ) {
      const block = streamEvent.content_block as Record<string, unknown>;
      if (block.type === 'tool_use')
        result.push(
          make({
            type: 'tool_use',
            callId: valueString(block.id, newId('call')),
            tool: valueString(block.name, 'tool'),
            input: block.input ?? {},
          }),
        );
    }
  }
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text') result.push(...text('text', block.text));
    else if (block.type === 'thinking')
      result.push(...text('thinking', block.thinking ?? block.text));
    else if (block.type === 'tool_use')
      result.push(
        make({
          type: 'tool_use',
          callId: valueString(block.id, newId('call')),
          tool: valueString(block.name, 'tool'),
          input: block.input ?? {},
        }),
      );
    else if (block.type === 'tool_result')
      result.push(
        make({
          type: 'tool_result',
          callId: valueString(block.tool_use_id ?? block.id, newId('call')),
          output:
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          truncated: block.is_error === true,
        }),
      );
  }
  if (event.type === 'result' && typeof event.usage === 'object' && event.usage !== null) {
    const usage = event.usage as Record<string, unknown>;
    result.push(
      make({
        type: 'usage',
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
      }),
    );
  }
  if (event.type === 'error')
    result.push(
      make({
        type: 'error',
        message: valueString(event.error ?? event.message, 'Claude CLI error'),
      }),
    );
  return result;
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
    const tool = typeof event.tool === 'string' ? event.tool : part?.tool;
    if (event.type === 'tool' && typeof tool === 'string') onProgress(`Tool: ${tool}`);
    const text = typeof part?.text === 'string' ? part.text : event.text;
    if (event.type === 'text' && typeof text === 'string') state.final += text;
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
  promptOnStdin: boolean,
): Promise<{ stdout: string; stderr: string }> {
  const executable = await executablePath(name, request.executable);
  const invocation = commandInvocation(executable, args);
  const launchFile = invocation.file;
  const launchArgs = invocation.args;
  const command = execa(launchFile, launchArgs, {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    reject: false,
    windowsHide: true,
    buffer: false,
    detached: process.platform !== 'win32',
    ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  command.stdin.end(promptOnStdin ? request.prompt : undefined);
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
  const commandSettled = command.then(
    () => undefined,
    () => undefined,
  );
  const killTree = async () => {
    if (process.platform === 'win32') command.kill('SIGTERM');
    else signalProcessGroup(command.pid, 'SIGTERM');
    if (process.platform === 'win32' && command.pid !== undefined) {
      try {
        const killed = await execa('taskkill.exe', ['/pid', String(command.pid), '/T', '/F'], {
          reject: false,
          windowsHide: true,
          timeout: 2_000,
        });
        if (
          killed.failed &&
          !isTaskkillNotFound(killed.exitCode, `${killed.stderr}${killed.stdout}`)
        )
          console.warn(
            `Delegate process tree termination failed: ${killed.stderr || killed.stdout}`,
          );
      } catch (error) {
        console.warn('Delegate process tree termination failed', error);
      }
    }
    await Promise.race([
      commandSettled,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  };
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void killTree()
      .catch((error: unknown) => {
        console.warn('Delegate process tree termination failed', error);
      })
      .finally(() => rejectAbort?.(new Error('Delegate cancelled')));
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  let timer: NodeJS.Timeout | undefined;
  const watchdog = { timedOut: false };
  try {
    const outcome = await Promise.race([
      command,
      aborted,
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
    if (outcome.failed && outcome.exitCode === undefined && typeof outcome.code === 'string') {
      const details =
        (typeof outcome.shortMessage === 'string' && outcome.shortMessage) ||
        (typeof outcome.message === 'string' && outcome.message) ||
        `could not start ${invocation.file}`;
      throw new Error(`Failed to start CLI (${outcome.code}): ${details}`, { cause: outcome });
    }
    if (outcome.failed)
      throw new Error(stderr || `CLI exited with code ${String(outcome.exitCode)}`);
    return { stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
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

export function mapAcpUpdate(value: unknown): AgentEvent[] {
  if (!value || typeof value !== 'object') return [];
  const update = value as Record<string, unknown>;
  const kind = valueString(update.sessionUpdate ?? update.type);
  const content = update.content as Record<string, unknown> | undefined;
  const text = typeof content?.text === 'string' ? content.text : undefined;
  const at = new Date().toISOString();
  const event = (fields: Record<string, unknown>): AgentEvent =>
    ({ ...fields, id: newId('event'), timestamp: at }) as AgentEvent;
  const callId = valueString(update.toolCallId ?? update.callId ?? update.id, newId('call'));
  if (kind === 'agent_message_chunk' || kind === 'agentMessageChunk')
    return text ? [event({ type: 'text', content: text })] : [];
  if (kind === 'agent_thought_chunk' || kind === 'agentThoughtChunk')
    return text ? [event({ type: 'thinking', content: text })] : [];
  if (kind === 'tool_call' || kind === 'toolCall')
    return [
      event({
        type: 'tool_use',
        callId,
        tool: valueString(update.title, 'tool'),
        input: update.rawInput ?? {},
      }),
    ];
  if (kind === 'tool_call_update' || kind === 'toolCallUpdate') {
    const status = valueString(update.status, 'running');
    if (['completed', 'failed', 'cancelled'].includes(status))
      return [
        event({
          type: 'tool_result',
          callId,
          output: valueString(update.output ?? update.content, status),
          truncated: update.truncated === true,
        }),
      ];
    return [event({ type: 'status', status, message: valueString(update.title, 'Tool running') })];
  }
  if (kind === 'usage_update' || kind === 'usageUpdate')
    return [
      event({
        type: 'usage',
        inputTokens: Number(update.inputTokens ?? update.input_tokens ?? 0),
        outputTokens: Number(update.outputTokens ?? update.output_tokens ?? 0),
      }),
    ];
  if (kind === 'plan' || kind === 'plan_update' || kind === 'planUpdate')
    return [
      event({
        type: 'status',
        status: kind,
        message: acpUpdateText(value as import('@agentclientprotocol/sdk').SessionUpdate),
      }),
    ];
  return [event({ type: 'status', status: kind || 'unknown', message: JSON.stringify(update) })];
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
    detached: process.platform !== 'win32',
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
  const events: AgentEvent[] = [];
  let final = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let threadId: string | null = null;
  let connection: ClientConnection | undefined;
  let killInFlight: Promise<void> | undefined;
  const killTree = async () => {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else signalProcessGroup(child.pid, 'SIGTERM');
    if (process.platform === 'win32' && child.pid !== undefined) {
      try {
        const result = await execa('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          reject: false,
          windowsHide: true,
          timeout: 2_000,
        });
        if (
          result.failed &&
          !isTaskkillNotFound(result.exitCode, `${result.stderr}${result.stdout}`)
        )
          console.warn('ACP process tree termination failed', result.stderr);
      } catch (error) {
        console.warn('ACP process tree termination failed', error);
      }
    }
    await Promise.race([
      child.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  };
  const onAbort = () => {
    if (connection && threadId)
      void connection.agent
        .notify('session/cancel', { sessionId: threadId })
        .catch(() => undefined);
    killInFlight = killTree();
  };
  const reportEvent = (event: AgentEvent) => {
    const bounded = boundEventOutput(event, artifactsDir);
    events.push(bounded);
    if (events.length > 2_000) events.shift();
    request.onEvent?.(bounded);
    const text = summarizeAgentEvent(bounded);
    progress.push(text);
    if (progress.length > 2_000) progress.shift();
    request.onProgress?.(text);
  };
  const client = acpClient({ name: 'Ferry' })
    .onRequest('fs/read_text_file', async ({ params }) => {
      if (isProtectedWorkspacePath(params.path))
        throw new Error('ACP access to credential and secret files is denied');
      const safePath = await assertAcpWorkspacePath(request.cwd, params.path, false);
      return { content: await readFile(safePath, 'utf8') };
    })
    .onRequest('fs/write_text_file', async ({ params }) => {
      if (isProtectedWorkspacePath(params.path))
        throw new Error('ACP access to credential and secret files is denied');
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
      for (const event of mapAcpUpdate(params.update)) reportEvent(event);
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
        clientInfo: { name: 'Ferry', version: '0.9.0' },
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
      events,
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
  assertSafeArguments([executable, ...args]);
  const isShim =
    process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase());
  return isShim
    ? {
        file: process.env.SystemRoot
          ? join(process.env.SystemRoot, 'System32', 'cmd.exe')
          : 'cmd.exe',
        args: [
          '/d',
          '/v:off',
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
  const events: AgentEvent[] = [];
  const state = {
    threadId: null as string | null,
    final: '',
    input: 0,
    output: 0,
    cost: null as number | null,
  };
  const progress = (text: string) => {
    if (!text) return;
    raw.push(text);
    if (raw.length > 2_000) raw.shift();
    request.onProgress?.(text);
  };
  const emitEvent = (event: AgentEvent) => {
    const bounded = boundEventOutput(event, artifactsDir);
    events.push(bounded);
    if (events.length > 2_000) events.shift();
    raw.push(summarizeAgentEvent(bounded));
    if (raw.length > 2_000) raw.shift();
    request.onEvent?.(bounded);
    request.onProgress?.(summarizeAgentEvent(bounded));
  };
  try {
    const requestedOpenCodeModel = request.model?.trim();
    const openCodeModel =
      name === 'opencode'
        ? requestedOpenCodeModel && requestedOpenCodeModel.length > 0
          ? requestedOpenCodeModel
          : await readOpenCodeDefaultModel(request.cwd, { ...process.env, ...request.env })
        : undefined;
    if (name === 'opencode' && !openCodeModel)
      throw new Error(
        'Choose a model for OpenCode in Settings \u2192 Delegation, or set a default model in your OpenCode config.',
      );
    const openCodePromptPath = name === 'opencode' ? join(artifactsDir, 'brief.md') : undefined;
    if (openCodePromptPath) await writeFile(openCodePromptPath, request.prompt, 'utf8');
    const cliRequest = {
      ...request,
      ...(openCodeModel ? { model: openCodeModel } : {}),
      ...(openCodePromptPath ? { promptFilePath: openCodePromptPath } : {}),
    };
    const codexVersion =
      name === 'codex' && request.resumeId ? await readCliVersion(name, request) : undefined;
    const args = buildCliArgs(name, cliRequest, outputPath, codexVersion ?? undefined);
    let openCodeEventCount = 0;
    const codexResumePromptIsArgument =
      name === 'codex' && request.resumeId && usesCodexResumeV159Syntax(codexVersion ?? undefined);
    const execution = await execute(
      name,
      args,
      cliRequest,
      (line) => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          progress(line);
          return;
        }
        if (typeof event === 'object' && event !== null) {
          const parsed = event as Record<string, unknown>;
          if (name === 'opencode') {
            openCodeEventCount += 1;
          }
          parseEvent(name, parsed, state, progress);
          for (const event of mapCliEvent(name, parsed)) emitEvent(event);
        }
      },
      !codexResumePromptIsArgument && name !== 'opencode',
    );
    if (execution.stderr.trim()) progress(`[CLI stderr tail] ${execution.stderr.slice(-4_000)}`);
    if (name === 'opencode' && !state.final.trim())
      throw new Error(
        `OpenCode exited without assistant text (received ${String(openCodeEventCount)} JSON events${state.threadId ? `; session ${state.threadId}` : ''}). Check its configured default model or set a lane model.`,
      );
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
      events,
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
    events: [],
    finalMessage: null,
    touchedFiles: [],
    gateResults: [],
    usage: null,
    decision: null,
  });
  let threadId: string | null = null;
  let lastEventProgress: string | undefined;
  const update = (text?: string) => {
    if (text && text === lastEventProgress) {
      lastEventProgress = undefined;
      return;
    }
    if (text) {
      run.progress = [...run.progress, { at: new Date().toISOString(), text }].slice(-2_000);
    }
    input.onUpdate?.(structuredClone(run));
  };
  const updateEvent = (event: AgentEvent) => {
    run.events = [...run.events, event].slice(-2_000);
    const summary = summarizeAgentEvent(event);
    lastEventProgress = summary;
    run.progress = [...run.progress, { at: event.timestamp, text: summary }].slice(-2_000);
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
          onEvent: updateEvent,
        },
      );
      threadId = result.threadId;
      if (threadId) update(`Delegate session id: ${threadId}`);
      run.status = 'completed';
      run.finalMessage = result.finalMessage;
      run.usage = result.usage;
      run.touchedFiles = await input.checkpointDiff();
      run.finishedAt = new Date().toISOString();
      updateEvent({
        id: newId('event'),
        type: 'status',
        status: 'completed',
        message: 'Delegate completed.',
        timestamp: run.finishedAt,
      });
      update();
      return run;
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      run.finalMessage = error instanceof Error ? error.message : String(error);
      run.finishedAt = new Date().toISOString();
      updateEvent({
        id: newId('event'),
        type: 'error',
        message: run.finalMessage,
        timestamp: run.finishedAt,
      });
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
          onEvent: updateEvent,
        },
      );
      threadId = resumed.threadId ?? threadId;
      if (threadId) update(`Delegate session id: ${threadId}`);
      run.brief = brief;
      run.finalMessage = resumed.finalMessage;
      run.usage = resumed.usage;
      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      run.touchedFiles = await input.checkpointDiff();
      updateEvent({
        id: newId('event'),
        type: 'status',
        status: 'completed',
        message: 'Delegate rework completed.',
        timestamp: run.finishedAt,
      });
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
    run.events = [...run.events, ...resumed.events].slice(-2_000);
    run.progress = [...run.progress, ...resumed.progress].slice(-2_000);
    run.finalMessage = resumed.finalMessage;
    run.usage = resumed.usage;
    run.touchedFiles = resumed.touchedFiles;
    run.gateResults = resumed.gateResults;
    run.status = resumed.status;
    run.finishedAt = resumed.finishedAt;
  }
  run.decision = decision;
  return run;
}

export const delegatePaths = {
  normalize: (path: string) => resolve(path),
  isWithin: (root: string, path: string) => {
    const caseFold = (value: string) =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    const base = caseFold(resolve(root));
    const target = caseFold(resolve(base, path));
    const pathFromRoot = relative(base, target);
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
  },
};

export async function assertAcpWorkspacePath(
  workspace: string,
  target: string,
  writing: boolean,
): Promise<string> {
  if (isProtectedWorkspacePath(target))
    throw new Error('ACP access to credential and secret files is denied');
  if (
    (hasWindowsDrivePrefix(target) && !win32.isAbsolute(target)) ||
    // On POSIX `win32.isAbsolute('/x')` is also true; only reject Windows drive/UNC forms there.
    (process.platform !== 'win32' && win32.isAbsolute(target) && !target.startsWith('/'))
  )
    throw new Error('ACP file path escapes the delegation workspace');
  const root = await realpath(resolve(workspace));
  const normalizedTarget = normalizePathSeparators(target);
  const absolute = isAbsolute(normalizedTarget)
    ? resolve(normalizedTarget)
    : resolve(workspace, normalizedTarget);
  const canonical = await canonicalizeWithExistingAncestor(absolute);
  if (!delegatePaths.isWithin(root, canonical)) {
    if (delegatePaths.isWithin(resolve(workspace), absolute))
      throw new Error('ACP file path escapes the delegation workspace through a symlink');
    throw new Error('ACP file path escapes the delegation workspace');
  }
  if (writing) return canonical;
  const actual = await realpath(absolute);
  if (!delegatePaths.isWithin(root, actual))
    throw new Error('ACP file path escapes the delegation workspace through a symlink');
  return actual;
}

async function canonicalizeWithExistingAncestor(path: string): Promise<string> {
  let probe = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      const actual = await realpath(probe);
      return resolve(actual, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = resolve(probe, '..');
      if (parent === probe)
        throw new Error('ACP file path has no existing workspace parent', { cause: error });
      suffix.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}
