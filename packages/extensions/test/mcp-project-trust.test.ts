import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMcpServerConfigs } from '../src/mcp.js';

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferry-mcp-trust-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      ),
  );
});

describe('project MCP trust pinning', () => {
  it('requires explicit approval of the exact project config hash', async () => {
    const root = await temporaryDirectory();
    const projectPath = join(root, 'project');
    const projectConfigPath = join(projectPath, '.ferry', 'mcp.json');
    await mkdir(join(projectPath, '.ferry'), { recursive: true });
    const config = JSON.stringify({
      servers: [
        {
          id: 'local-tools',
          name: 'Local tools',
          transport: 'stdio',
          command: 'node',
          enabled: true,
        },
      ],
    });
    await writeFile(projectConfigPath, config, 'utf8');
    const configHash = createHash('sha256')
      .update(
        JSON.stringify([
          {
            id: 'local-tools',
            name: 'Local tools',
            transport: 'stdio',
            command: 'node',
            args: [],
            env: {},
            enabled: true,
          },
        ]),
      )
      .digest('hex');
    const approval = vi.fn((hash: string): boolean => hash === configHash);
    const options = { projectPath, projectConfigPath, approveProjectConfig: approval };
    await expect(loadMcpServerConfigs(options)).resolves.toHaveLength(1);
    await writeFile(
      projectConfigPath,
      config.replace('"command":"node"', '"command":"changed-node"'),
      'utf8',
    );
    await expect(loadMcpServerConfigs(options)).resolves.toEqual([]);
    expect(approval).toHaveBeenCalledTimes(2);
    expect(approval.mock.calls[0]?.[0]).not.toBe(approval.mock.calls[1]?.[0]);
  });

  it('does not enable project servers without an approval callback', async () => {
    const root = await temporaryDirectory();
    const projectPath = join(root, 'project');
    const projectConfigPath = join(projectPath, '.ferry', 'mcp.json');
    await mkdir(join(projectPath, '.ferry'), { recursive: true });
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        servers: [
          {
            id: 'remote-tools',
            name: 'Remote tools',
            transport: 'http',
            url: 'https://mcp.example.invalid',
            enabled: true,
          },
        ],
      }),
      'utf8',
    );
    await expect(loadMcpServerConfigs({ projectPath, projectConfigPath })).resolves.toEqual([]);
  });
});
