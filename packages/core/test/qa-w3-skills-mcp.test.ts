import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadMcpServerConfigs,
  McpManager,
  SkillManager,
  type McpServerConfig,
  type McpStatusEvent,
} from '@ferry/extensions';

const fixture = fileURLToPath(
  new URL('../../extensions/test/fixtures/tiny-mcp-server.mjs', import.meta.url),
);
const roots: string[] = [];
const managers: McpManager[] = [];
const originalPath = process.env.PATH;

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8 })),
  );
});

function stdioConfig(id: string): McpServerConfig {
  return {
    id,
    name: `Tiny ${id}`,
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: {},
    enabled: true,
  };
}

async function putSkill(root: string, name: string, body = 'Skill body'): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: QA skill\n---\n\n${body}\n`,
    'utf8',
  );
}

describe('QA W3 skills: read_skill_file jail', () => {
  it('refuses relative, traversal and absolute paths outside the skill directory', async () => {
    const project = await temp('qa-skills-');
    const bundled = join(project, 'bundled');
    await putSkill(bundled, 'docs');
    const secret = join(project, 'secret.txt');
    await writeFile(secret, 'top secret', 'utf8');
    const manager = new SkillManager({ projectPath: project, bundledPath: bundled });
    await manager.load();
    for (const path of ['../secret.txt', '..\\..\\secret.txt', secret]) {
      await expect(
        manager.callSkillTool('read_skill_file', { name: 'docs', path }),
      ).rejects.toThrow(/escapes the skill directory/);
    }
    await expect(
      manager.callSkillTool('read_skill_file', { name: 'docs', path: '.' }),
    ).rejects.toThrow(/must be a file/);
    await expect(
      manager.callSkillTool('read_skill_file', { name: 'docs', path: '' }),
    ).rejects.toThrow(/required/);
  });

  it('refuses to read through a symlink that escapes the skill directory', async () => {
    const project = await temp('qa-skills-');
    const bundled = join(project, 'bundled');
    await putSkill(bundled, 'docs');
    const secret = join(project, 'secret.txt');
    await writeFile(secret, 'top secret', 'utf8');
    let symlinked = false;
    try {
      await symlink(secret, join(bundled, 'docs', 'leak.txt'));
      symlinked = true;
    } catch {
      // Windows without Developer Mode cannot create symlinks; nothing to test.
    }
    if (!symlinked) return;
    const manager = new SkillManager({ projectPath: project, bundledPath: bundled });
    await manager.load();
    await expect(
      manager.callSkillTool('read_skill_file', { name: 'docs', path: 'leak.txt' }),
    ).rejects.toThrow(/escapes the skill directory/);
    await expect(readFile(secret, 'utf8')).resolves.toBe('top secret');
  });
});

describe('QA W3 mcp: approval, collisions and crashes', () => {
  it('requires the exact approved project config hash and re-prompts after a change', async () => {
    const root = await temp('qa-mcp-');
    const userConfigPath = join(root, 'user.json');
    const projectConfigPath = join(root, 'project.json');
    await writeFile(userConfigPath, '[]', 'utf8');
    await writeFile(projectConfigPath, JSON.stringify([stdioConfig('project-a')]), 'utf8');
    const unapproved = await loadMcpServerConfigs({
      projectPath: root,
      userConfigPath,
      projectConfigPath,
      approveProjectConfig: () => false,
    });
    expect(unapproved).toEqual([]);
    let approvedHash: string | null = null;
    const approved = await loadMcpServerConfigs({
      projectPath: root,
      userConfigPath,
      projectConfigPath,
      approveProjectConfig: (hash) => {
        approvedHash = hash;
        return true;
      },
    });
    expect(approved.map(({ config }) => config.id)).toEqual(['project-a']);
    await writeFile(
      projectConfigPath,
      JSON.stringify([stdioConfig('project-a'), stdioConfig('project-b')]),
      'utf8',
    );
    const stale = await loadMcpServerConfigs({
      projectPath: root,
      userConfigPath,
      projectConfigPath,
      approveProjectConfig: (hash) => hash === approvedHash,
    });
    expect(stale).toEqual([]);
    const reapproved = await loadMcpServerConfigs({
      projectPath: root,
      userConfigPath,
      projectConfigPath,
      approveProjectConfig: () => true,
    });
    expect(reapproved.map(({ config }) => config.id)).toEqual(['project-a', 'project-b']);
  });

  it('surfaces an error status when a server exits during startup', async () => {
    const root = await temp('qa-mcp-');
    const statuses: McpStatusEvent[] = [];
    const manager = new McpManager({
      projectPath: root,
      onStatus: (event) => statuses.push(event),
      maxReconnectAttempts: 0,
      reconnectInitialMs: 20,
    });
    managers.push(manager);
    const dead: McpServerConfig = {
      id: 'dead',
      name: 'Tiny dead',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      env: {},
      enabled: true,
    };
    await manager.configure([dead]);
    await manager.connect();
    expect(statuses.some((event) => event.status === 'error')).toBe(true);
  });

  it('namespaces colliding tool names and rejects duplicate server ids', async () => {
    const root = await temp('qa-mcp-');
    const manager = new McpManager({ projectPath: root });
    managers.push(manager);
    await expect(manager.configure([stdioConfig('dup'), stdioConfig('dup')])).rejects.toThrow(
      /Duplicate MCP server id/,
    );
    await manager.configure([stdioConfig('alpha'), stdioConfig('beta')]);
    await manager.connect();
    const names = manager
      .toolSource()
      .listTools()
      .map((tool) => tool.name);
    expect(names).toContain('mcp__alpha__echo');
    expect(names).toContain('mcp__beta__echo');
    expect(names.filter((name) => name.endsWith('__echo'))).toHaveLength(2);
  });

  it('recovers a crashed server back to connected', async () => {
    const root = await temp('qa-mcp-');
    const manager = new McpManager({
      projectPath: root,
      reconnectInitialMs: 40,
      reconnectMaxMs: 40,
    });
    managers.push(manager);
    await manager.configure([stdioConfig('tiny')]);
    await manager.connect();
    expect(manager.list()[0]?.status).toBe('connected');
    await expect(
      manager.callTool('mcp__tiny__crash', {}, new AbortController().signal),
    ).rejects.toThrow();
    await vi.waitFor(
      () => {
        expect(manager.list()[0]?.status).toBe('connected');
      },
      { timeout: 5_000 },
    );
  }, 20_000);
});
