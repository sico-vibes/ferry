import { McpManager, McpServerConfigSchema } from '@ferry/extensions';
import { McpServerSchema } from '@ferry/shared';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { z } from 'zod';
import { join } from 'node:path';

const ConfigList = z.array(McpServerConfigSchema);
const workspaces = new WeakMap<
  FerryServices,
  Map<string, { manager: McpManager; configuration?: string; ready?: Promise<void> }>
>();

export function createMcpManager(
  services: FerryServices,
  host?: CoreHost,
  projectPath = services.workspaces.list()[0]?.path ?? process.cwd(),
): McpManager {
  let entries = workspaces.get(services);
  if (!entries) {
    entries = new Map();
    workspaces.set(services, entries);
  }
  const existing = entries.get(projectPath);
  if (existing) return existing.manager;
  const manager = new McpManager({
    projectPath,
    userConfigPath: join(services.paths.home, 'mcp.json'),
    onStatus: (event) => {
      host?.emit('mcp.status', event);
    },
  });
  entries.set(projectPath, { manager });
  return manager;
}

export async function connectWorkspaceMcp(
  services: FerryServices,
  host: CoreHost,
  projectPath: string,
): Promise<McpManager> {
  const manager = createMcpManager(services, host, projectPath);
  const entry = workspaces.get(services)?.get(projectPath);
  if (!entry) throw new Error('Missing workspace MCP manager');
  const configs = ConfigList.parse(services.settings.get('mcp-servers') ?? []);
  const configuration = JSON.stringify(configs);
  if (entry.configuration !== configuration) {
    const previous = entry.ready;
    entry.configuration = configuration;
    entry.ready = (async () => {
      await previous;
      await manager.configure(configs);
      await manager.connect();
    })().catch((error: unknown) => {
      services.logger.warn({ err: error }, 'MCP configuration failed');
    });
  }
  await entry.ready;
  return manager;
}

export async function removeWorkspaceMcp(
  services: FerryServices,
  projectPath: string,
): Promise<void> {
  const entries = workspaces.get(services);
  const entry = entries?.get(projectPath);
  entries?.delete(projectPath);
  if (!entry) return;
  // Dispose immediately to cancel any pending handshake, then after configuration finishes.
  await entry.manager.dispose();
  await entry.ready;
  await entry.manager.dispose();
}

export function register(host: CoreHost, services: FerryServices): void {
  const configs = () => ConfigList.parse(services.settings.get('mcp-servers') ?? []);
  const reconfigure = async (next = configs()) => {
    services.settings.put('mcp-servers', next);
    for (const workspace of services.workspaces.list())
      if (workspace.trusted) createMcpManager(services, host, workspace.path);
    await Promise.all(
      [...(workspaces.get(services)?.keys() ?? [])].map((path) =>
        connectWorkspaceMcp(services, host, path),
      ),
    );
  };
  host.registerDomain('mcp', {
    list() {
      const states = [...(workspaces.get(services)?.values() ?? [])].flatMap(({ manager }) =>
        manager.list(),
      );
      const connected = new Map(
        states
          .sort((a, b) => Number(a.status === 'connected') - Number(b.status === 'connected'))
          .map((server) => [String(server.id), server]),
      );
      return Promise.resolve(
        configs().map((config) =>
          McpServerSchema.parse(
            connected.get(config.id) ?? {
              id: config.id,
              name: config.name,
              brand: null,
              transport: config.transport,
              status: 'disconnected',
              verified: true,
              toolCount: 0,
            },
          ),
        ),
      );
    },
    async setEnabled(rawId: unknown, rawEnabled: unknown) {
      const id = z.string().min(1).parse(rawId);
      if (typeof rawEnabled !== 'boolean')
        throw rpcDomainError(-32010, 'validation', 'Enabled must be a boolean');
      const current = configs();
      if (!current.some((item) => item.id === id))
        throw rpcDomainError(-32044, 'not_found', `MCP server not found: ${id}`);
      const next = current.map((item) =>
        item.id === id ? { ...item, enabled: rawEnabled } : item,
      );
      await reconfigure(next);
      const result = [...(workspaces.get(services)?.values() ?? [])]
        .flatMap(({ manager }) => manager.list())
        .find((item) => String(item.id) === id) ?? {
        id,
        name: next.find((item) => item.id === id)?.name ?? id,
        brand: null,
        transport: next.find((item) => item.id === id)?.transport ?? 'stdio',
        status: 'disconnected' as const,
        verified: true,
        toolCount: 0,
      };
      return McpServerSchema.parse(result);
    },
  });
  host.onShutdown(async () => {
    await Promise.all(
      [...(workspaces.get(services)?.keys() ?? [])].map((path) =>
        removeWorkspaceMcp(services, path),
      ),
    );
  });
  void reconfigure().catch((error: unknown) => {
    services.logger.warn({ err: error }, 'MCP configuration failed');
  });
}
