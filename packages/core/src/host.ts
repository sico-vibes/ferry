import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DomainErrorKindSchema,
  FERRY_DOMAINS,
  FERRY_EVENTS,
  FERRY_METHODS,
  FERRY_PROTOCOL,
  HelloParamsSchema,
  JsonRpcRequestSchema,
  SystemInfoSchema,
  rpcError,
  type JsonRpcRequest,
} from '@ferry/shared';
import { startCoreWebSocketServer, type CoreWebSocketHandle } from './websocket.js';
import { ZodError } from 'zod';

export type RpcHandler = (...params: unknown[]) => unknown;
export interface CoreTransport {
  send(message: unknown): void;
  subscribe(handler: (message: unknown) => void): () => void;
  close?(): void;
}
export interface CoreOptions {
  dataDir: string;
  transport?: CoreTransport;
  selfTest?: () =>
    | { modules: { name: string; ok: boolean; version: string | null; error: string | null }[] }
    | Promise<{
        modules: { name: string; ok: boolean; version: string | null; error: string | null }[];
      }>;
  websocketEnabled?: boolean;
  websocketPort?: number;
  services?: import('./services.js').FerryServices;
}

export class CoreLockError extends Error {
  constructor(readonly dataDir: string) {
    super(`A Ferry core is already running for data directory: ${dataDir}`);
    this.name = 'CoreLockError';
  }
}

export function mapError(error: unknown) {
  if (error instanceof ZodError)
    return rpcError(-32010, 'validation', 'Domain parameters or result failed validation');
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
  ) {
    const parsedKind = 'kind' in error ? DomainErrorKindSchema.safeParse(error.kind) : undefined;
    return rpcError(
      error.code,
      parsedKind?.success ? parsedKind.data : 'domain_error',
      error instanceof Error ? error.message : 'Domain request failed',
      'details' in error ? error.details : undefined,
    );
  }
  return rpcError(-32603, 'internal', error instanceof Error ? error.message : 'Internal error');
}

export function rpcDomainError(
  code: number,
  kind: 'not_found' | 'validation' | 'conflict' | 'permission_denied' | 'unavailable',
  message: string,
): Error & { code: number; kind: string } {
  return Object.assign(new Error(message), { code, kind });
}

export class CoreHost {
  readonly dataDir: string;
  readonly #registry = new Map<string, Map<string, RpcHandler>>();
  readonly #events = new Set<(method: string, payload: unknown) => void>();
  #releaseLock: (() => Promise<void>) | undefined;
  #unsubscribe: (() => void) | undefined;
  #websocket: CoreWebSocketHandle | undefined;
  #started = false;

  constructor(readonly options: CoreOptions) {
    this.dataDir = resolve(options.dataDir);
  }

  get websocket(): CoreWebSocketHandle | undefined {
    return this.#websocket;
  }

  get realDomains(): string[] {
    return [...this.#registry.keys()];
  }

  registerDomain(domain: string, handlers: Record<string, RpcHandler>): void {
    if (this.#started) throw new Error('Cannot register handlers after core start');
    if (!FERRY_DOMAINS.includes(domain)) throw new Error(`Unknown Ferry domain: ${domain}`);
    const entries = this.#registry.get(domain) ?? new Map<string, RpcHandler>();
    for (const [method, handler] of Object.entries(handlers)) {
      const name = `${domain}.${method}`;
      if (!(FERRY_METHODS as readonly string[]).includes(name))
        throw new Error(`Unknown Ferry method: ${name}`);
      entries.set(method, handler);
    }
    this.#registry.set(domain, entries);
  }

  emit(method: string, payload: unknown): void {
    if (!(FERRY_EVENTS as readonly string[]).includes(method))
      throw new Error(`Unknown Ferry event: ${method}`);
    for (const listener of this.#events) listener(method, payload);
  }

  onEvent(listener: (method: string, payload: unknown) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await mkdir(this.dataDir, { recursive: true });
    const lockPath = resolve(this.dataDir, 'core.lock');
    await mkdir(dirname(lockPath), { recursive: true });
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        let ownerPid: number | undefined;
        try {
          const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
          if (typeof owner.pid === 'number') ownerPid = owner.pid;
        } catch {
          /* incomplete lock is stale */
        }
        let alive = ownerPid !== undefined;
        if (ownerPid !== undefined) {
          try {
            process.kill(ownerPid, 0);
          } catch {
            alive = false;
          }
        }
        if (alive) throw new CoreLockError(this.dataDir);
        await unlink(lockPath).catch(() => undefined);
        try {
          handle = await open(lockPath, 'wx');
        } catch {
          throw new CoreLockError(this.dataDir);
        }
      } else throw error;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, protocol: FERRY_PROTOCOL }));
    await handle.close();
    this.#releaseLock = async () => {
      try {
        await unlink(lockPath);
      } catch {
        /* already released */
      }
    };
    this.#started = true;
    if (this.options.transport)
      this.#unsubscribe = this.options.transport.subscribe((message) => {
        void this.handleMessage(message);
      });
    this.onEvent((method, params) =>
      this.options.transport?.send({ jsonrpc: '2.0', method, params }),
    );
    if (this.options.websocketEnabled) {
      try {
        this.#websocket = await startCoreWebSocketServer(this, this.options.websocketPort ?? 0);
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#unsubscribe?.();
    await this.#websocket?.close();
    this.#websocket = undefined;
    this.options.transport?.close?.();
    await this.options.services?.dispose();
    await this.#releaseLock?.();
    this.#started = false;
  }

  async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null || !('id' in raw)) return;
    const parsed = JsonRpcRequestSchema.safeParse(raw);
    const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : null;
    if (!parsed.success) {
      this.options.transport?.send({
        jsonrpc: '2.0',
        id,
        error: rpcError(-32600, 'invalid_request', 'Invalid JSON-RPC request'),
      });
      return;
    }
    const request = parsed.data;
    try {
      const result = await this.dispatch(request);
      this.options.transport?.send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      const mapped =
        error instanceof DispatchError
          ? rpcError(error.code, error.kind, error.message)
          : mapError(error);
      this.options.transport?.send({ jsonrpc: '2.0', id: request.id, error: mapped });
    }
  }

  async dispatch(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === 'system.info') {
      const info = {
        version: '0.1.0',
        mock: false,
        platform: process.platform,
        dataDir: this.dataDir,
        realDomains: this.realDomains,
      };
      return SystemInfoSchema.parse(info);
    }
    if (request.method === 'system.hello') {
      const params = HelloParamsSchema.safeParse(request.params?.[0]);
      if (!params.success || params.data.protocol !== FERRY_PROTOCOL)
        throw new DispatchError(-32002, 'protocol_mismatch', `Core requires ${FERRY_PROTOCOL}`);
      const implementedMethods = [...this.#registry].flatMap(([domain, methods]) =>
        [...methods.keys()].map((method) => `${domain}.${method}`),
      );
      return {
        protocol: FERRY_PROTOCOL,
        capabilities: ['events', 'selfTest'],
        realDomains: [...new Set(implementedMethods.map((name) => name.split('.')[0] ?? ''))],
        implementedMethods,
      };
    }
    if (request.method === 'system.selfTest') {
      if (!this.options.selfTest) return { modules: [] };
      return this.options.selfTest();
    }
    const [domain, method] = request.method.split('.');
    if (!domain || !method || !(FERRY_METHODS as readonly string[]).includes(request.method))
      throw new DispatchError(-32601, 'unknown_method', `Unknown method: ${request.method}`);
    const handler = this.#registry.get(domain)?.get(method);
    if (!handler)
      throw new DispatchError(
        -32004,
        'not_implemented',
        `Method is not implemented: ${request.method}`,
      );
    return await handler(...(request.params ?? []));
  }
}

class DispatchError extends Error {
  constructor(
    readonly code: number,
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export function createMemoryTransportPair(): [CoreTransport, CoreTransport] {
  let leftHandler: ((message: unknown) => void) | undefined;
  let rightHandler: ((message: unknown) => void) | undefined;
  return [
    {
      send: (message) => {
        queueMicrotask(() => rightHandler?.(message));
      },
      subscribe: (handler) => {
        leftHandler = handler;
        return () => {
          leftHandler = undefined;
        };
      },
    },
    {
      send: (message) => {
        queueMicrotask(() => leftHandler?.(message));
      },
      subscribe: (handler) => {
        rightHandler = handler;
        return () => {
          rightHandler = undefined;
        };
      },
    },
  ];
}

export function createStdioTransport(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): CoreTransport {
  let handler: ((message: unknown) => void) | undefined;
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line)
        try {
          handler?.(JSON.parse(line) as unknown);
        } catch {
          /* dispatcher reports malformed JSON separately when framed */
        }
    }
  });
  return {
    send(message) {
      output.write(`${JSON.stringify(message)}\n`);
    },
    subscribe(listener) {
      handler = listener;
      return () => {
        handler = undefined;
      };
    },
  };
}

export async function serveStdio(dataDir: string): Promise<CoreHost> {
  const host = new CoreHost({
    dataDir,
    transport: createStdioTransport(process.stdin, process.stdout),
  });
  await host.start();
  return host;
}

export async function createCoreHost(
  options: Omit<CoreOptions, 'services'> & {
    clock?: import('./services.js').FerryClock;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CoreHost> {
  const { createServices } = await import('./services.js');
  const { domainRegistrars } = await import('./domains/index.js');
  const services = await createServices({
    dataDir: options.dataDir,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const host = new CoreHost({ ...options, services });
  for (const register of domainRegistrars) register(host, services);
  try {
    await host.start();
  } catch (error) {
    await services.dispose();
    throw error;
  }
  return host;
}

export async function readLockInfo(dataDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(dataDir, 'core.lock'), 'utf8')) as unknown;
  } catch {
    return null;
  }
}
