import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
    url: z.string().url(),
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
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport;
  tools: ToolDef[];
  status: McpStatus;
  attempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  generation: number;
}

const DEFAULT_USER_CONFIG = (): string => join(getDataPaths().home, 'mcp.json');
const emptyFile = async (path: string): Promise<unknown[]> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(value) ? value : ((value as { servers?: unknown[] }).servers ?? []);
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
): Promise<Array<{ config: McpServerConfig; source: 'user' | 'project' }>> {
  const userRaw = await emptyFile(options.userConfigPath ?? DEFAULT_USER_CONFIG());
  const projectRaw = await emptyFile(
    options.projectConfigPath ?? join(options.projectPath, '.ferry', 'mcp.json'),
  );
  const user = userRaw.map((item) => ({
    config: McpServerConfigSchema.parse(item),
    source: 'user' as const,
  }));
  const project = projectRaw.map((item) => ({
    config: McpServerConfigSchema.parse(item),
    source: 'project' as const,
  }));
  const approved = new Set<string>();
  if (project.length) {
    const hash = createHash('sha256')
      .update(JSON.stringify(project.map(({ config }) => config)))
      .digest('hex');
    if (await options.approveProjectConfig?.(hash)) approved.add(hash);
  }
  return [...user, ...project.filter(({ config }) => config.enabled && approved.size > 0)];
}

export class McpManager {
  private readonly options: McpClientOptions;
  private readonly servers = new Map<string, ServerState>();
  private disposed = false;

  constructor(options: McpClientOptions) {
    this.options = options;
  }

  async configure(
    configs: Array<McpServerConfig | { config: McpServerConfig; source: 'user' | 'project' }>,
  ): Promise<void> {
    await this.disposeConnections();
    this.disposed = false;
    this.servers.clear();
    for (const item of configs) {
      const wrapped = 'config' in item ? item : { config: item, source: 'user' as const };
      const config = McpServerConfigSchema.parse(wrapped.config);
      if (!config.enabled) continue;
      if (this.servers.has(config.id)) throw new Error(`Duplicate MCP server id: ${config.id}`);
      this.servers.set(config.id, {
        config,
        source: wrapped.source,
        tools: [],
        status: 'disconnected',
        attempts: 0,
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
    const manager = this;
    return {
      id: 'mcp',
      listTools: () =>
        [...manager.servers.values()].flatMap((state) =>
          state.status === 'connected'
            ? state.tools.map((tool) => ({
                ...tool,
                name: manager.namespacedName(state.config.id, tool.name),
              }))
            : [],
        ),
      call(name, args, signal) {
        return manager.callTool(name, args, signal);
      },
    };
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const match = /^mcp__([^_]+(?:_[^_]+)*)__([\s\S]+)$/.exec(name);
    if (!match) throw new Error(`Invalid MCP tool name: ${name}`);
    const state = this.requireState(match[1] ?? '');
    if (state.status !== 'connected' || !state.client)
      throw new Error(`MCP server ${state.config.id} is not connected`);
    const toolName = match[2] ?? '';
    if (!state.tools.some((tool) => tool.name === toolName))
      throw new Error(`Unknown MCP tool: ${name}`);
    if (signal.aborted) throw signal.reason ?? new Error('MCP tool call cancelled');
    const controller = new AbortController();
    const relayAbort = (): void =>
      controller.abort(signal.reason ?? new Error('MCP tool call cancelled'));
    signal.addEventListener('abort', relayAbort, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`MCP tool call timed out after ${String(this.options.timeoutMs ?? 30_000)}ms`),
        ),
      this.options.timeoutMs ?? 30_000,
    );
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
              env: { ...process.env, ...state.config.env },
              stderr: 'pipe',
            })
          : new StreamableHTTPClientTransport(new URL(state.config.url));
      transport.onclose = () => {
        if (!this.disposed && state.generation === generation) this.scheduleReconnect(state);
      };
      transport.onerror = (error) => {
        this.setStatus(state, 'error', error.message);
      };
      await client.connect(transport);
      if (this.disposed || state.generation !== generation) {
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
    return `mcp__${serverId.replaceAll('-', '_')}__${toolName}`;
  }
  private asArguments(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null || Array.isArray(args))
      throw new Error('MCP tool arguments must be an object');
    return args as Record<string, unknown>;
  }
}
