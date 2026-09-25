import { McpManager, McpServerConfigSchema } from '@ferry/extensions';
import { McpServerSchema } from '@ferry/shared';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { z } from 'zod';
import { join } from 'node:path';

const ConfigList = z.array(McpServerConfigSchema);

export function createMcpManager(
  services: FerryServices,
  host?: CoreHost,
  projectPath = services.workspaces.list()[0]?.path ?? process.cwd(),
): McpManager {
  return new McpManager({
    projectPath,
    userConfigPath: join(services.paths.home, 'mcp.json'),
    onStatus: (event) => {
      host?.emit('mcp.status', event);
    },
  });
}

export function register(host: CoreHost, services: FerryServices): void {
  const manager = createMcpManager(services, host);
  const configs = () => ConfigList.parse(services.settings.get('mcp-servers') ?? []);
  const reconfigure = async (next = configs()) => {
    services.settings.put('mcp-servers', next);
    await manager.configure(next);
    await manager.connect();
  };
  host.registerDomain('mcp', {
    list() {
      const connected = new Map(manager.list().map((server) => [String(server.id), server]));
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
      const result = manager.list().find((item) => String(item.id) === id) ?? {
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
  void reconfigure().catch((error: unknown) => {
    services.logger.warn({ err: error }, 'MCP configuration failed');
  });
}
