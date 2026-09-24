import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { DelegationRunSchema, LaneSchema, newId } from '@ferry/shared';
import type { DelegationRun, FileChange, Lane, SessionId } from '@ferry/shared';
import type { BriefingSection } from '@ferry/router';

export type Implementer = 'codex' | 'opencode' | 'claude';
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
    if (!['codex', 'opencode', 'claude', 'ferry'].includes(String(entry.implementer))) continue;
    const lane = LaneSchema.safeParse({
      name,
      implementer: entry.implementer,
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
const tokenUnsafe = /[\0;&|<>^%!]/;
export function assertSafeArguments(args: readonly string[]): void {
  for (const arg of args) {
    if (tokenUnsafe.test(arg)) throw new Error(`Unsafe CLI argument rejected: ${arg}`);
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
      request.prompt,
    );
  } else if (name === 'opencode') {
    args.push('run');
    if (request.resumeId) args.push('--session', request.resumeId);
    if (request.model) args.push('--model', request.model);
    if (request.mode) args.push('--agent', request.mode);
    if (request.variant) args.push('--variant', request.variant);
    if (request.mode === 'build') args.push('--yolo');
    args.push('--format', 'json', request.prompt);
  } else {
    args.push('-p', request.prompt, '--output-format', 'stream-json', '--verbose');
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

async function executablePath(name: Implementer, custom?: string): Promise<string> {
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
  const command = execa(executable, args, {
    cwd: request.cwd,
    reject: false,
    shell:
      process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase()),
    windowsHide: true,
    buffer: false,
  });
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
  try {
    const outcome = await Promise.race([
      command,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void killTree().finally(() => {
            reject(new Error(`Delegate timed out after ${String(timeout)}ms`));
          });
        }, timeout);
      }),
    ]);
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

export async function detectCli(
  name: Implementer,
  options: { executable?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<CliDetection> {
  const executable = await executablePath(name, options.executable);
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    const version = await execa(executable, ['--version'], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      reject: false,
      shell: process.platform === 'win32' && extname(executable).toLowerCase() === '.cmd',
      windowsHide: true,
      timeout: timeoutMs,
    });
    if (version.failed)
      return {
        available: false,
        authenticated: false,
        version: null,
        executable,
        error: version.stderr || 'Version probe failed',
      };
    const authArgs =
      name === 'codex'
        ? ['login', 'status']
        : name === 'opencode'
          ? ['auth', 'list']
          : ['auth', 'status'];
    const auth = await execa(executable, authArgs, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      reject: false,
      shell: process.platform === 'win32' && extname(executable).toLowerCase() === '.cmd',
      windowsHide: true,
      timeout: timeoutMs,
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
  sessionId: SessionId;
  lane: Lane;
  brief: string;
  cwd: string;
  timeoutMs?: number;
  checkpointDiff: () => Promise<FileChange[]>;
  onUpdate?: (run: DelegationRun) => void;
}
export interface DelegationHandle {
  run: Promise<DelegationRun>;
  cancel(): void;
  resume(brief: string): Promise<DelegationRun>;
}
export function startDelegation(input: StartDelegationInput): DelegationHandle {
  const controller = new AbortController();
  const runId = newId('run') as DelegationRun['id'];
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
      const result = await runAdapter(input.lane.implementer as Implementer, {
        prompt: input.brief,
        cwd: input.cwd,
        ...(input.lane.model ? { model: input.lane.model } : {}),
        ...(input.lane.effort ? { effort: input.lane.effort } : {}),
        ...(input.lane.variant ? { variant: input.lane.variant } : {}),
        mode: input.lane.permission === 'read_only' ? 'plan' : 'build',
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: controller.signal,
        onProgress: (text) => {
          update(text);
        },
      });
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
      const resumed = await runAdapter(input.lane.implementer as Implementer, {
        prompt: brief,
        cwd: input.cwd,
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
      });
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
