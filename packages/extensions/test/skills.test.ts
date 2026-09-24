import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSkillFile, SkillManager } from '../src/skills.js';

const temporary: string[] = [];
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ferry-skills-'));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function putSkill(
  root: string,
  name: string,
  description: string,
  body = 'Instructions',
  extra = '',
): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`,
    'utf8',
  );
}

describe('SkillManager', () => {
  it('loads source precedence, maps to shared type, and renders only enabled descriptions', async () => {
    const project = await folder();
    const user = await folder();
    const bundled = await folder();
    const claude = await folder();
    await putSkill(join(project, '.ferry', 'skills'), 'same', 'project version');
    await putSkill(user, 'same', 'user version');
    await putSkill(user, 'user-only', 'user skill');
    await putSkill(bundled, 'same', 'bundled version');
    await putSkill(bundled, 'bundled-only', 'bundled skill');
    await putSkill(claude, 'same', 'claude version');
    await putSkill(claude, 'claude-only', 'claude skill');
    const onEnabledChange = vi.fn();
    const manager = new SkillManager({
      projectPath: project,
      userSkillsPath: user,
      bundledPath: bundled,
      claudeSkillsPath: claude,
      importClaude: true,
      onEnabledChange,
    });
    expect((await manager.load()).map(({ name, source }) => [name, source])).toEqual([
      ['same', 'project'],
      ['user-only', 'user'],
      ['bundled-only', 'bundled'],
      ['claude-only', 'claude'],
    ]);
    await manager.setEnabled('user-only', false);
    expect(onEnabledChange).toHaveBeenCalledOnce();
    expect(manager.promptSection().render({})).toContain('- same: project version');
    expect(manager.promptSection().render({})).not.toContain('user-only');
    expect(manager.list().every((skill) => typeof skill.id === 'string')).toBe(true);
  });

  it('reports frontmatter errors and loads skill body and jailed reference files', async () => {
    const root = await folder();
    const malformed = join(root, 'bad.md');
    await writeFile(malformed, 'no frontmatter', 'utf8');
    await expect(parseSkillFile(malformed)).rejects.toThrow('must start with YAML frontmatter');
    const project = await folder();
    const bundled = join(root, 'bundled');
    await putSkill(bundled, 'docs', 'Read references', 'Skill body');
    const skillDir = join(bundled, 'docs');
    await mkdir(join(skillDir, 'references'));
    await writeFile(join(skillDir, 'references', 'guide.md'), 'Reference content', 'utf8');
    const outside = join(root, 'secret.txt');
    await writeFile(outside, 'secret', 'utf8');
    const manager = new SkillManager({ projectPath: project, bundledPath: bundled });
    await manager.load();
    const source = manager.toolSource();
    expect(await source.call('load_skill', { name: 'docs' }, new AbortController().signal)).toBe(
      'Skill body',
    );
    expect(
      await source.call(
        'read_skill_file',
        { name: 'docs', path: 'references/guide.md' },
        new AbortController().signal,
      ),
    ).toBe('Reference content');
    await expect(
      source.call('read_skill_file', { name: 'docs', path: outside }, new AbortController().signal),
    ).rejects.toThrow('escapes');
    await expect(readFile(outside, 'utf8')).resolves.toBe('secret');
  });
});
