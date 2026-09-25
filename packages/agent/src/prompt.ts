import { readFile } from 'node:fs/promises';
import { hostname, platform, release } from 'node:os';
import path from 'node:path';
import { gitBranch, gitStatus, WorkspaceJail } from '@ferry/workspace';
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
}

const BASE_RULES = `You are Ferry, a coding agent working in the user's repository.
Use the provided tools to inspect and change files. Read before editing, make focused changes, and verify outcomes with available commands. Explain uncertainty and never claim an action succeeded unless its tool result confirms it.
The workspace is the only project boundary. Do not access credentials or secrets. Ask before risky commands and honor approval decisions.
Windows is the primary platform. Use PowerShell for shell commands, preserve existing CRLF/LF line endings, and use node:path semantics for paths. Avoid destructive commands.`;

export async function assembleSystemPrompt(options: PromptAssemblyOptions): Promise<string> {
  const jail = new WorkspaceJail(options.workspace);
  const [branch, status, instructions] = await Promise.all([
    gitBranch(jail).catch(() => null),
    gitStatus(jail).catch(() => null),
    findInstructions(options.workspace),
  ]);
  const branchName = branch?.current ?? '(detached or unavailable)';
  const changes = status
    ? [...status.modified, ...status.created, ...status.deleted, ...status.not_added].slice(0, 40)
    : [];
  const environment = [
    `OS: ${platform()} ${release()} (${hostname()})`,
    `Shell: ${options.shell ?? 'PowerShell'}`,
    `Date: ${(options.now ?? new Date()).toISOString()}`,
    `Workspace: ${path.resolve(options.workspace)}`,
    `Git branch: ${branchName}`,
    `Git status: ${changes.length ? changes.join(', ') : status ? 'clean' : 'unavailable'}`,
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
