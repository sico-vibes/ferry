import { createHash } from 'node:crypto';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataPaths } from '@ferry/config';
import { SkillSchema, type Skill } from '@ferry/shared';
import { parseDocument } from 'yaml';
import type { PromptSection, ToolDef, ToolSource } from './types.js';

export type SkillSource = Skill['source'];
export interface LoadedSkill extends Skill {
  body: string;
  directory: string;
  metadata?: Record<string, unknown>;
}
export interface SkillManagerOptions {
  projectPath: string;
  bundledPath?: string;
  userSkillsPath?: string;
  claudeSkillsPath?: string;
  importClaude?: boolean;
  getEnabled?: (
    skill: Pick<Skill, 'name' | 'description' | 'source'>,
  ) => boolean | undefined | Promise<boolean | undefined>;
  onEnabledChange?: (skill: Skill, enabled: boolean) => void | Promise<void>;
}

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const readText = async (path: string): Promise<string> => readFile(path, 'utf8');
const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

function isJailed(root: string, candidate: string): boolean {
  const path = resolve(candidate);
  const rel = relative(resolve(root), path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function parseSkillFile(
  filePath: string,
): Promise<Pick<LoadedSkill, 'name' | 'description' | 'body' | 'metadata'>> {
  const raw = await readText(filePath);
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`Skill file ${filePath} must start with YAML frontmatter`);
  const frontmatter = parseDocument(match[1] ?? '');
  if (frontmatter.errors.length)
    throw new Error(
      `Invalid skill frontmatter in ${filePath}: ${frontmatter.errors[0]?.message ?? 'invalid YAML'}`,
    );
  const data: unknown = frontmatter.toJSON();
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error(`Skill frontmatter in ${filePath} must be an object`);
  const values = data as Record<string, unknown>;
  const name = values.name;
  const description = values.description;
  if (typeof name !== 'string' || !skillNamePattern.test(name))
    throw new Error(
      `Skill name in ${filePath} must be lowercase alphanumeric words separated by hyphens`,
    );
  if (typeof description !== 'string' || !description.trim())
    throw new Error(`Skill ${name} in ${filePath} needs a non-empty description`);
  const metadata = values.metadata;
  if (
    metadata !== undefined &&
    (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
  )
    throw new Error(`Skill metadata in ${filePath} must be an object`);
  return {
    name,
    description: description.trim(),
    body: (match[2] ?? '').trim(),
    ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
  };
}

export class SkillManager {
  private readonly skills = new Map<string, LoadedSkill>();
  private readonly enabled = new Map<string, boolean>();
  private readonly options: SkillManagerOptions;

  constructor(options: SkillManagerOptions) {
    this.options = options;
  }

  async load(): Promise<Skill[]> {
    this.skills.clear();
    const sources: { source: SkillSource; root: string }[] = [
      { source: 'project', root: join(this.options.projectPath, '.ferry', 'skills') },
      { source: 'user', root: this.options.userSkillsPath ?? getDataPaths().skills },
      {
        source: 'bundled',
        root:
          this.options.bundledPath ??
          resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills'),
      },
      ...(this.options.importClaude
        ? [
            {
              source: 'claude' as const,
              root: this.options.claudeSkillsPath ?? join(homedir(), '.claude', 'skills'),
            },
          ]
        : []),
    ];
    for (const { source, root } of sources) {
      if (!(await exists(root))) continue;
      for (const entry of (await readdir(root, { withFileTypes: true }))
        .filter((item) => item.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const directory = join(root, entry.name);
        const file = join(directory, 'SKILL.md');
        if (!(await exists(file))) continue;
        const parsed = await parseSkillFile(file);
        if (this.skills.has(parsed.name)) continue;
        const id = `skill_${createHash('sha256').update(`${source}:${parsed.name}`).digest('hex').slice(0, 20)}`;
        const savedEnabled = await this.options.getEnabled?.({
          name: parsed.name,
          description: parsed.description,
          source,
        });
        const skill = SkillSchema.parse({
          id,
          name: parsed.name,
          description: parsed.description,
          source,
          enabled: this.enabled.get(parsed.name) ?? savedEnabled ?? true,
        });
        this.skills.set(skill.name, {
          ...skill,
          body: parsed.body,
          directory,
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        });
      }
    }
    return this.list();
  }

  list(): Skill[] {
    return [...this.skills.values()].map(({ id, name, description, source, enabled }) => ({
      id,
      name,
      description,
      source,
      enabled,
    }));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const current = this.skills.get(name);
    if (!current) throw new Error(`Unknown skill: ${name}`);
    this.enabled.set(name, enabled);
    const updated = { ...current, enabled };
    this.skills.set(name, updated);
    await this.options.onEnabledChange?.(this.toShared(updated), enabled);
  }

  promptSection(): PromptSection {
    return {
      id: 'skills',
      order: 700,
      render: () => {
        const entries = [...this.skills.values()].filter((skill) => skill.enabled);
        return entries.length === 0
          ? ''
          : `Available skills (load a skill when relevant):\n${entries.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`;
      },
    };
  }

  toolSource(): ToolSource {
    const callSkillTool = this.callSkillTool.bind(this);
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    };
    const tools: ToolDef[] = [
      {
        name: 'load_skill',
        description: 'Load the full instructions for an enabled skill by name.',
        inputSchema: schema,
      },
      {
        name: 'read_skill_file',
        description: 'Read a file under an enabled skill directory, such as a references file.',
        inputSchema: schema,
      },
    ];
    return {
      id: 'skills',
      listTools: () => tools,
      call: (name, args) => callSkillTool(name, args),
    };
  }

  async callSkillTool(toolName: string, args: unknown): Promise<string> {
    if (typeof args !== 'object' || args === null)
      throw new Error('Tool arguments must be an object');
    const values = args as Record<string, unknown>;
    const name = values.name;
    if (typeof name !== 'string') throw new Error('Skill name is required');
    const skill = this.skills.get(name);
    if (!skill?.enabled) throw new Error(`Skill is unavailable: ${name}`);
    if (toolName === 'load_skill') return skill.body;
    if (toolName !== 'read_skill_file') throw new Error(`Unknown skill tool: ${toolName}`);
    if (typeof values.path !== 'string' || !values.path.trim())
      throw new Error('Skill file path is required');
    const path = resolve(skill.directory, values.path);
    if (!isJailed(skill.directory, path))
      throw new Error('Skill file path escapes the skill directory');
    const root = await realpath(skill.directory);
    const canonicalPath = await realpath(path);
    if (!isJailed(root, canonicalPath))
      throw new Error('Skill file path escapes the skill directory');
    const info = await import('node:fs/promises').then(({ stat }) => stat(canonicalPath));
    if (!info.isFile()) throw new Error('Skill reference path must be a file');
    return readText(canonicalPath);
  }

  private toShared(skill: LoadedSkill): Skill {
    return SkillSchema.parse({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      enabled: skill.enabled,
    });
  }
}
