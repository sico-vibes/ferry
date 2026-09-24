import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMcpServerConfigs, McpManager, type McpServerConfig } from '../src/mcp.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ferry-mcp-'));
  created.push(path);
  return path;
}
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiny-mcp-server.mjs');
const config: McpServerConfig = {
  id: 'tiny',
  name: 'Tiny test server',
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env: {},
  enabled: true,
};

describe('McpManager', () => {
  it('connects, lists and calls tools from an SDK stdio test server', async () => {
    const onStatus = vi.fn();
    const manager = new McpManager({ projectPath: process.cwd(), onStatus });
    await manager.configure([config]);
    await manager.connect();
    expect(manager.list()[0]).toMatchObject({ id: 'tiny', status: 'connected', toolCount: 3 });
    const source = manager.toolSource();
    expect(source.listTools().map((tool) => tool.name)).toContain('mcp__tiny__echo');
    await expect(
      source.call('mcp__tiny__echo', { text: 'hello' }, new AbortController().signal),
    ).resolves.toMatchObject({ content: [{ text: 'hello' }] });
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'tiny', status: 'connected', toolCount: 3 }),
    );
    await manager.dispose();
  });

  it('honors cancellation and timeouts for tool calls', async () => {
    const manager = new McpManager({
      projectPath: process.cwd(),
      timeoutMs: 100,
      maxReconnectAttempts: 0,
    });
    await manager.configure([config]);
    await manager.connect();
    const controller = new AbortController();
    const pending = manager.callTool('mcp__tiny__wait', { ms: 1_000 }, controller.signal);
    controller.abort(new Error('cancel requested'));
    await expect(pending).rejects.toThrow('cancel requested');
    await expect(
      manager.callTool('mcp__tiny__wait', { ms: 1_000 }, new AbortController().signal),
    ).rejects.toThrow();
    await manager.dispose();
  });

  it('requires explicit approval for project config and only loads enabled servers', async () => {
    const root = await temp();
    const userConfigPath = join(root, 'user.json');
    const projectConfigPath = join(root, 'project.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(userConfigPath, JSON.stringify([{ ...config, enabled: false }]), 'utf8');
    await writeFile(
      projectConfigPath,
      JSON.stringify([{ ...config, id: 'project', enabled: true }]),
      'utf8',
    );
    const approve = vi.fn(async (hash: string) => hash.length === 64);
    const loaded = await loadMcpServerConfigs({
      projectPath: root,
      userConfigPath,
      projectConfigPath,
      approveProjectConfig: approve,
    });
    expect(loaded.map(({ config: item, source }) => [item.id, source])).toEqual([
      ['project', 'project'],
    ]);
    expect(approve).toHaveBeenCalledOnce();
  });

  it('reconnects after a server process exits and emits status changes', async () => {
    const onStatus = vi.fn();
    const manager = new McpManager({
      projectPath: process.cwd(),
      onStatus,
      reconnectInitialMs: 40,
      reconnectMaxMs: 40,
    });
    await manager.configure([config]);
    await manager.connect();
    await expect(
      manager.callTool('mcp__tiny__crash', {}, new AbortController().signal),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('connected'), { timeout: 5_000 });
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'tiny', status: 'disconnected' }),
    );
    await manager.dispose();
  });
});
