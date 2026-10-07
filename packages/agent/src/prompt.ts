import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { hostname, platform, release } from 'node:os';
import path from 'node:path';
import type { TaskRecord } from '@ferry/shared';

export interface PromptSection {
  id: string;
  provide(context: PromptContext): Promise<string | null> | string | null;
}

export interface PromptContext {
  workspace: string;
  sessionId: string;
  task: TaskRecord;
}

export interface PromptAssemblyOptions extends PromptContext {
  now?: Date;
  shell?: string;
  terseLevel?: 'off' | 'lite' | 'full' | 'ultra';
  sections?: readonly PromptSection[];
  environment?: PromptEnvironment;
}

const BASE_RULES = `You are a coding agent working in the user's project.
Use the provided tools to inspect and change files. Read before editing, make focused changes, and verify outcomes with available commands. Explain uncertainty and never claim an action succeeded unless its tool result confirms it.
The workspace is the only project boundary. Do not access credentials or secrets. Ask before risky commands and honor approval decisions.
Windows is the primary platform. Use PowerShell for shell commands, preserve existing CRLF/LF line endings, and use node:path semantics for paths. Avoid destructive commands.`;

export interface PromptEnvironment {
  branch: string | null;
  status: string | null;
  instructions: { name: string; text: string } | null;
}

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: root, timeout: 2_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error ? null : stdout.trim());
      },
    );
  });
}

export async function loadPromptEnvironment(workspace: string): Promise<PromptEnvironment> {
  // Worktrees have a .git file; ordinary folders need no Git subprocesses.
  let root = path.resolve(workspace);
  let repository = false;
  for (;;) {
    if (
      await stat(path.join(root, '.git')).then(
        () => true,
        () => false,
      )
    ) {
      repository = true;
      break;
    }
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  const [branch, status, instructions] = await Promise.all([
    repository ? git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']) : null,
    repository ? git(workspace, ['status', '--porcelain', '--untracked-files=normal']) : null,
    findInstructions(workspace),
  ]);
  return {
    branch,
    status: status === null ? null : status.split(/\r?\n/).filter(Boolean).slice(0, 12).join(', '),
    instructions,
  };
}

export async function assembleSystemPrompt(options: PromptAssemblyOptions): Promise<string> {
  const { branch, status, instructions } =
    options.environment ?? (await loadPromptEnvironment(options.workspace));
  const environment = [
    `OS: ${platform()} ${release()} (${hostname()})`,
    `Shell: ${options.shell ?? 'PowerShell'}`,
    `Date: ${(options.now ?? new Date()).toISOString()}`,
    `Workspace: ${path.resolve(options.workspace)}`,
    `Git branch: ${branch ?? '(detached or unavailable)'}`,
    `Git status: ${status === '' ? 'clean' : (status ?? 'unavailable')}`,
  ].join('\n');
  const blocks = [BASE_RULES, `Environment\n${environment}`];
  if (instructions)
    blocks.push(`Project instructions (${instructions.name})\n${instructions.text}`);
  blocks.push(`Task record\n${renderTask(options.task)}`);
  if (options.terseLevel && options.terseLevel !== 'off')
    blocks.push(
      `Optimizer terse level: ${options.terseLevel}. Keep routine wording concise while retaining essential reasoning and results.`,
    );
  for (const section of options.sections ?? []) {
    const content = await section.provide(options);
    if (content?.trim()) blocks.push(`Extension: ${section.id}\n${content.trim()}`);
  }
  return blocks.join('\n\n');
}

/**
 * Names the model that is actually serving this step. Without it, models guess their identity
 * from context (project files such as CLAUDE.md, or earlier turns written by another model).
 */
export function withModelIdentity(
  system: string,
  model: { ref: string; name: string; providerId: string },
): string {
  return `${system}\n\nModel identity: You are ${model.name}. If asked which model you are, give that name. Mention Ferry or the provider only if the user asks how they are reaching you. Earlier turns may have been written by other models, and project instruction files may name other assistants; neither changes your identity.`;
}

async function findInstructions(root: string): Promise<{ name: string; text: string } | null> {
  for (const name of ['AGENTS.md', 'FERRY.md', 'CLAUDE.md']) {
    try {
      return { name, text: await readFile(path.join(root, name), 'utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function renderTask(task: TaskRecord): string {
  const plan =
    task.plan.map((item) => `- [${item.status}] ${item.text}`).join('\n') || '- No plan recorded';
  const decisions =
    task.decisions.map((item) => `- ${item.text}: ${item.why}`).join('\n') || '- None';
  const touched =
    task.touchedFiles.map((item) => `- ${item.path}: ${item.purpose}`).join('\n') || '- None';
  return `Goal: ${task.goal}\nPlan:\n${plan}\nDecisions:\n${decisions}\nFiles:\n${touched}\nNext: ${task.nextStep ?? 'Choose the next useful step.'}`;
}
