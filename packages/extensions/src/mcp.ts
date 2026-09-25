import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getDataPaths } from '@ferry/config';
import { McpServerSchema, type McpServer } from '@ferry/shared';
import { z } from 'zod';
import type { ToolDef, ToolSource } from './types.js';

export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(false),
  }),
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    transport: z.literal('http'),
    url: z.url(),
    enabled: z.boolean().default(false),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpStatus = 'connected' | 'disconnected' | 'error';
export interface McpStatusEvent {
  serverId: string;
  status: McpStatus;
  toolCount: number;
  error?: string;
}
export interface McpClientOptions {
  projectPath: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  approveProjectConfig?: (hash: string) => boolean | Promise<boolean>;
  onStatus?: (event: McpStatusEvent) => void;
  timeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  maxReconnectAttempts?: number;
}

interface ServerState {
  config: McpServerConfig;
  source: 'user' | 'project';
  client: Client | undefined;
  transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
  tools: ToolDef[];
  status: McpStatus;
  attempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  generation: number;
}

const DEFAULT_USER_CONFIG = (): string => join(getDataPaths().home, 'mcp.json');
const mcpConfigFileSchema = z.union([
  z.array(z.unknown()),
  z.object({ servers: z.array(z.unknown()) }),
]);
const emptyFile = async (path: string): Promise<unknown[]> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const value = mcpConfigFileSchema.parse(parsed);
    return Array.isArray(value) ? value : value.servers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

export async function loadMcpServerConfigs(
  options: Pick<
    McpClientOptions,
    'projectPath' | 'userConfigPath' | 'projectConfigPath' | 'approveProjectConfig'
  >,
): Promise<{ config: McpServerConfig; source: 'user' | 'project' }[]> {
  const userRaw = await emptyFile(options.userConfigPath ?? DEFAULT_USER_CONFIG());
  const projectRaw = await emptyFile(
    options.projectConfigPath ?? join(options.projectPath, '.ferry', 'mcp.json'),
  );
  const user = userRaw
    .map((item) => ({
      config: McpServerConfigSchema.parse(item),
      source: 'user' as const,
    }))
    .filter(({ config }) => config.enabled);
  const project = projectRaw.map((item) => ({
    config: McpServerConfigSchema.parse(item),
    source: 'project' as const,
  }));
  let projectApproved = false;
  if (project.length) {
    const hash = createHash('sha256')
      .update(JSON.stringify(project.map(({ config }) => config)))
      .digest('hex');
    projectApproved = (await options.approveProjectConfig?.(hash)) ?? false;
  }
  return [...user, ...project.filter(({ config }) => config.enabled && projectApproved)];
}

export class McpManager {
  private readonly options: McpClientOptions;
  private readonly servers = new Map<string, ServerState>();
  private disposed = false;

  constructor(options: McpClientOptions) {
    this.options = options;
  }

  async configure(
    configs: (McpServerConfig | { config: McpServerConfig; source: 'user' | 'project' })[],
  ): Promise<void> {
    await this.disposeConnections();
    this.disposed = false;
    this.servers.clear();
    const parsed = configs.map((item) => {
      const wrapped = 'config' in item ? item : { config: item, source: 'user' as const };
      return { ...wrapped, config: McpServerConfigSchema.parse(wrapped.config) };
    });
    const projectConfigs = parsed
      .filter(({ source }) => source === 'project')
      .map(({ config }) => config);
    const projectHash = createHash('sha256').update(JSON.stringify(projectConfigs)).digest('hex');
    const projectApproved =
      projectConfigs.length === 0 ||
      (await this.options.approveProjectConfig?.(projectHash)) === true;
    for (const { config, source } of parsed) {
      if (!config.enabled) continue;
      if (source === 'project' && !projectApproved) continue;
      if (this.servers.has(config.id)) throw new Error(`Duplicate MCP server id: ${config.id}`);
      this.servers.set(config.id, {
        config,
        source,
        client: undefined,
        transport: undefined,
        tools: [],
        status: 'disconnected',
        attempts: 0,
        reconnectTimer: undefined,
        generation: 0,
      });
    }
  }

  async connect(serverId?: string): Promise<void> {
    const states = serverId ? [this.requireState(serverId)] : [...this.servers.values()];
    await Promise.all(states.map((state) => this.connectState(state)));
  }

  list(): McpServer[] {
    return [...this.servers.values()].map((state) =>
      McpServerSchema.parse({
        id: state.config.id,
        name: state.config.name,
        brand: null,
        transport: state.config.transport,
        status: state.status,
        verified: state.source === 'user',
        toolCount: state.tools.length,
      }),
    );
  }

  toolSource(): ToolSource {
    const listTools = (): ToolDef[] =>
      [...this.servers.values()].flatMap((state) =>
        state.status === 'connected'
          ? state.tools.map((tool) => ({
              ...tool,
              name: this.namespacedName(state.config.id, tool.name),
            }))
          : [],
      );
    const callTool = this.callTool.bind(this);
    return {
      id: 'mcp',
      listTools,
      call(name, args, signal) {
        return callTool(name, args, signal);
      },
    };
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const state = [...this.servers.values()].find((candidate) =>
      name.startsWith(`mcp__${candidate.config.id}__`),
    );
    if (!state) throw new Error(`Invalid MCP tool name: ${name}`);
    if (state.status !== 'connected' || !state.client)
      throw new Error(`MCP server ${state.config.id} is not connected`);
    const toolName = name.slice(`mcp__${state.config.id}__`.length);
    if (!state.tools.some((tool) => tool.name === toolName))
      throw new Error(`Unknown MCP tool: ${name}`);
    if (signal.aborted) throw signal.reason ?? new Error('MCP tool call cancelled');
    const controller = new AbortController();
    const relayAbort = (): void => {
      controller.abort(signal.reason ?? new Error('MCP tool call cancelled'));
    };
    signal.addEventListener('abort', relayAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`MCP tool call timed out after ${String(this.options.timeoutMs ?? 30_000)}ms`),
      );
    }, this.options.timeoutMs ?? 30_000);
    try {
      return await state.client.callTool(
        { name: toolName, arguments: this.asArguments(args) },
        undefined,
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', relayAbort);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const state = this.requireState(serverId);
    state.generation += 1;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    await state.client?.close().catch(() => undefined);
    state.client = undefined;
    state.transport = undefined;
    state.tools = [];
    this.setStatus(state, 'disconnected');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disposeConnections();
  }

  private async disposeConnections(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map(async (state) => {
        state.generation += 1;
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        await state.client?.close().catch(() => undefined);
      }),
    );
  }

  private async connectState(state: ServerState): Promise<void> {
    if (this.disposed) return;
    const generation = ++state.generation;
    try {
      const client = new Client({ name: 'ferry', version: '0.0.0' });
      const transport =
        state.config.transport === 'stdio'
          ? new StdioClientTransport({
              command: state.config.command,
              args: state.config.args,
              ...(Object.keys(state.config.env).length > 0 ? { env: state.config.env } : {}),
              stderr: 'pipe',
            })
          : new StreamableHTTPClientTransport(new URL(state.config.url));
      transport.onclose = () => {
        if (!this.disposed && state.generation === generation) {
          state.client = undefined;
          state.transport = undefined;
          state.tools = [];
          this.scheduleReconnect(state);
        }
      };
      transport.onerror = (error) => {
        this.setStatus(state, 'error', error.message);
      };
      await client.connect(transport as unknown as Transport);
      if (state.generation !== generation) {
        await client.close();
        return;
      }
      const result = await client.listTools();
      state.client = client;
      state.transport = transport;
      state.tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      }));
      state.attempts = 0;
      this.setStatus(state, 'connected');
    } catch (error) {
      if (state.generation !== generation) return;
      this.setStatus(state, 'error', error instanceof Error ? error.message : String(error));
      this.scheduleReconnect(state);
    }
  }

  private scheduleReconnect(state: ServerState): void {
    if (
      this.disposed ||
      state.reconnectTimer ||
      state.attempts >= (this.options.maxReconnectAttempts ?? 8)
    ) {
      if (!this.disposed && state.attempts >= (this.options.maxReconnectAttempts ?? 8))
        this.setStatus(state, 'disconnected');
      return;
    }
    this.setStatus(state, 'disconnected');
    const initial = this.options.reconnectInitialMs ?? 500;
    const max = this.options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, initial * 2 ** state.attempts);
    state.attempts += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      void this.connectState(state);
    }, delay);
  }

  private setStatus(state: ServerState, status: McpStatus, error?: string): void {
    state.status = status;
    this.options.onStatus?.({
      serverId: state.config.id,
      status,
      toolCount: state.tools.length,
      ...(error ? { error } : {}),
    });
  }

  private requireState(id: string): ServerState {
    const state = this.servers.get(id);
    if (!state) throw new Error(`Unknown or disabled MCP server: ${id}`);
    return state;
  }

  private namespacedName(serverId: string, toolName: string): string {
    return `mcp__${serverId}__${toolName}`;
  }
  private asArguments(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null || Array.isArray(args))
      throw new Error('MCP tool arguments must be an object');
    return args as Record<string, unknown>;
  }
}
