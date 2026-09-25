import { link, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
import { redactKnownSecrets } from '@ferry/shared';

const lockRecoveryGraceMs = 5_000;

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
      'details' in error ? redactKnownSecrets(error.details) : undefined,
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
  #unsubscribeEvents: (() => void) | undefined;
  #websocket: CoreWebSocketHandle | undefined;
  #started = false;
  #stopped = false;

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
    if (this.#stopped && this.options.services)
      throw new Error('already_stopped: composed core hosts cannot be restarted');
    await mkdir(this.dataDir, { recursive: true });
    const lockPath = resolve(this.dataDir, 'core.lock');
    await mkdir(dirname(lockPath), { recursive: true });
    const lockContents = JSON.stringify({ pid: process.pid, protocol: FERRY_PROTOCOL });
    const temporaryLockPath = `${lockPath}.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(temporaryLockPath, lockContents, { flag: 'wx' });
    let acquired: boolean;
    try {
      try {
        await link(temporaryLockPath, lockPath);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        acquired = await recoverStaleLock(lockPath, temporaryLockPath);
      }
    } finally {
      await unlink(temporaryLockPath).catch(() => undefined);
    }
    if (!acquired) throw new CoreLockError(this.dataDir);
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
    this.#unsubscribeEvents = this.onEvent((method, params) =>
      this.options.transport?.send({ jsonrpc: '2.0', method, params }),
    );
    if (this.options.services?.databaseRecoveryMessage)
      this.emit('toast', {
        message: this.options.services.databaseRecoveryMessage,
        tone: 'warning',
      });
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
    this.#unsubscribe = undefined;
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
    await this.#websocket?.close();
    this.#websocket = undefined;
    this.options.transport?.close?.();
    await this.options.services?.dispose();
    await this.#releaseLock?.();
    this.#releaseLock = undefined;
    this.#started = false;
    this.#stopped = true;
  }

  async handleMessage(raw: unknown): Promise<void> {
    if (!this.#started) {
      this.options.transport?.send({
        jsonrpc: '2.0',
        id:
          typeof raw === 'object' && raw !== null && 'id' in raw && validRpcId(raw.id)
            ? raw.id
            : null,
        error: rpcError(-32603, 'shutting_down', 'Core is shutting down'),
      });
      return;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        this.options.transport?.send({
          jsonrpc: '2.0',
          id: null,
          error: rpcError(-32600, 'invalid_request', 'Empty JSON-RPC batch'),
        });
        return;
      }
      const responses = await Promise.all(raw.map((message) => this.#responseFor(message)));
      const present = responses.filter((response) => response !== undefined);
      if (present.length) this.options.transport?.send(present);
      return;
    }
    const response = await this.#responseFor(raw);
    if (response !== undefined) this.options.transport?.send(response);
  }

  async #responseFor(raw: unknown): Promise<unknown> {
    if (typeof raw !== 'object' || raw === null || !('id' in raw)) return undefined;
    const parsed = JsonRpcRequestSchema.safeParse(raw);
    const id = validRpcId(raw.id) ? raw.id : null;
    if (!parsed.success) {
      return {
        jsonrpc: '2.0',
        id,
        error: rpcError(-32600, 'invalid_request', 'Invalid JSON-RPC request'),
      };
    }
    const request = parsed.data;
    try {
      const result = await this.dispatch(request);
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) {
      const mapped =
        error instanceof DispatchError
          ? rpcError(error.code, error.kind, error.message)
          : mapError(error);
      return { jsonrpc: '2.0', id: request.id, error: mapped };
    }
  }

  async dispatch(request: JsonRpcRequest, trustedTransport = true): Promise<unknown> {
    if (request.method === 'system.info') {
      const info = {
        version: '0.1.0',
        mock: false,
        platform: process.platform,
        dataDir: trustedTransport ? this.dataDir : null,
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

function validRpcId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
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
          output.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: rpcError(-32700, 'parse_error', 'Malformed JSON framing'),
            })}\n`,
          );
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
  const existingLock = await readLockInfo(options.dataDir);
  if (
    typeof existingLock === 'object' &&
    existingLock !== null &&
    'pid' in existingLock &&
    typeof existingLock.pid === 'number'
  ) {
    try {
      process.kill(existingLock.pid, 0);
      throw new CoreLockError(resolve(options.dataDir));
    } catch (error) {
      if (error instanceof CoreLockError) throw error;
      // Stale lock cleanup remains owned by CoreHost.start().
    }
  }
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

async function recoverStaleLock(lockPath: string, temporaryLockPath: string): Promise<boolean> {
  const recoveryPath = `${lockPath}.recovery`;
  try {
    await mkdir(recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recoveryStat = await stat(recoveryPath).catch(() => undefined);
    if (!recoveryStat || Date.now() - recoveryStat.mtimeMs <= lockRecoveryGraceMs) return false;
    await rm(recoveryPath, { recursive: true, force: true });
    try {
      await mkdir(recoveryPath);
    } catch {
      return false;
    }
  }

  try {
    if (!(await isStaleLock(lockPath))) return false;
    await unlink(lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    try {
      await link(temporaryLockPath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await rm(recoveryPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  let content: unknown;
  try {
    content = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
  } catch {
    return isOlderThanRecoveryGrace(lockPath);
  }
  if (typeof content === 'object' && content !== null && 'pid' in content) {
    const pid = content.pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
  }
  return isOlderThanRecoveryGrace(lockPath);
}

async function isOlderThanRecoveryGrace(lockPath: string): Promise<boolean> {
  const lockStat = await stat(lockPath).catch(() => undefined);
  return lockStat !== undefined && Date.now() - lockStat.mtimeMs > lockRecoveryGraceMs;
}

export async function readLockInfo(dataDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(dataDir, 'core.lock'), 'utf8')) as unknown;
  } catch {
    return null;
  }
}
