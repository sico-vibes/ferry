import { link, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  DomainErrorKindSchema,
  FERRY_DOMAINS,
  FERRY_EVENTS,
  FERRY_METHOD_PARAMS_SCHEMAS,
  FERRY_METHODS,
  FERRY_PROTOCOL,
  HelloParamsSchema,
  JsonRpcRequestSchema,
  SystemInfoSchema,
  rpcError,
  type JsonRpcRequest,
} from '@ferry/shared';
import { startCoreWebSocketServer, type CoreWebSocketHandle } from './websocket.js';
import { startLocalControlServer, type LocalControlServer } from './local-control.js';
import { ZodError } from 'zod';
import { redactKnownSecretText, redactKnownSecrets } from '@ferry/shared';
import { canonicalizePath } from '@ferry/shared/node-paths';
import { performance } from 'node:perf_hooks';

const lockRecoveryGraceMs = 5_000;

interface LifecycleRuntime {
  emitAppEvent?: (
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ) => void;
  env?: NodeJS.ProcessEnv;
  deviceId?: string;
  settings?: { get?: (key: string) => unknown };
}

function lifecycleRuntime(
  services: import('./services.js').FerryServices | undefined,
): LifecycleRuntime | undefined {
  return services;
}

function emitLifecycle(
  services: import('./services.js').FerryServices | undefined,
  event: string,
  data: Record<string, unknown>,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  lifecycleRuntime(services)?.emitAppEvent?.(event, data, level);
}

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
  localControl?: boolean;
  services?: import('./services.js').FerryServices;
}

export class CoreLockError extends Error {
  constructor(readonly dataDir: string) {
    super(`A Ferry core is already running for data directory: ${dataDir}`);
    this.name = 'CoreLockError';
  }
}

export function mapError(error: unknown, method?: string) {
  if (error instanceof ZodError)
    return rpcError(-32010, 'validation', 'Domain parameters or result failed validation', {
      ...(method ? { method } : {}),
      issues: error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
      })),
    });
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
      error instanceof Error ? redactKnownSecretText(error.message) : 'Domain request failed',
      'details' in error ? redactKnownSecrets(error.details) : undefined,
    );
  }
  return rpcError(
    -32603,
    'internal',
    error instanceof Error ? redactKnownSecretText(error.message) : 'Internal error',
  );
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
  readonly #shutdownHandlers = new Set<() => void | Promise<void>>();
  readonly #startHandlers = new Set<() => void | Promise<void>>();
  readonly #transportDisposers = new Map<CoreTransport, () => void>();
  #releaseLock: (() => Promise<void>) | undefined;
  #websocket: CoreWebSocketHandle | undefined;
  #localControl: LocalControlServer | undefined;
  #started = false;
  #stopped = false;
  #activeRpcMethods = new Map<string, number>();
  #eventLoopLagMs = 0;
  #lagTimer: ReturnType<typeof setTimeout> | undefined;
  #lagWarningIssued = false;
  #onUncaughtException = (error: Error) => {
    emitLifecycle(
      this.options.services,
      'app.crash',
      { error: redactKnownSecretText(error.message), kind: 'uncaughtException' },
      'error',
    );
    process.exitCode = 1;
  };
  #onUnhandledRejection = (reason: unknown) => {
    emitLifecycle(
      this.options.services,
      'app.crash',
      {
        error: redactKnownSecretText(reason instanceof Error ? reason.message : String(reason)),
        kind: 'unhandledRejection',
      },
      'error',
    );
    process.exitCode = 1;
  };

  constructor(readonly options: CoreOptions) {
    this.dataDir = canonicalizePath(options.dataDir);
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

  onShutdown(handler: () => void | Promise<void>): () => void {
    this.#shutdownHandlers.add(handler);
    return () => this.#shutdownHandlers.delete(handler);
  }

  onStart(handler: () => void | Promise<void>): () => void {
    this.#startHandlers.add(handler);
    return () => this.#startHandlers.delete(handler);
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
    let acquired = false;
    try {
      await writeFile(temporaryLockPath, lockContents, { flag: 'wx' });
      try {
        await link(temporaryLockPath, lockPath);
        acquired = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          acquired = await recoverStaleLock(lockPath, temporaryLockPath);
        } else if (!isLockContentionError(error)) {
          throw error;
        }
      }
    } catch (error) {
      if (!isLockContentionError(error)) throw error;
      acquired = false;
    } finally {
      await rm(temporaryLockPath, { force: true, maxRetries: 5, retryDelay: 50 }).catch(
        () => undefined,
      );
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
    process.on('uncaughtException', this.#onUncaughtException);
    process.on('unhandledRejection', this.#onUnhandledRejection);
    const lifecycle = lifecycleRuntime(this.options.services);
    const savedSettings = lifecycle?.settings?.get?.('global') as
      { storageMode?: string } | undefined;
    emitLifecycle(this.options.services, 'app.start', {
      version: lifecycle?.env?.FERRY_RELEASE_VERSION ?? '0.9.0',
      platform: process.platform,
      storageMode: savedSettings?.storageMode ?? 'local',
      deviceId: lifecycle?.deviceId ?? null,
    });
    this.#startLagMonitor();
    if (this.options.transport) this.#attachTransport(this.options.transport);
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
    await Promise.all(
      [...this.#startHandlers].map((handler) =>
        Promise.resolve()
          .then(handler)
          .catch((error: unknown) => {
            this.options.services?.logger.error({ err: error }, 'Core startup task failed');
          }),
      ),
    );
    const localControlEnabled = this.options.localControl ?? process.env.NODE_ENV !== 'test';
    if (localControlEnabled) {
      try {
        this.#localControl = await startLocalControlServer(this, this.dataDir);
      } catch (error) {
        const warning = 'Local control channel is unavailable; core started without CLI access';
        if (this.options.services) this.options.services.logger.warn({ err: error }, warning);
        else console.warn(warning, error);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    process.off('uncaughtException', this.#onUncaughtException);
    process.off('unhandledRejection', this.#onUnhandledRejection);
    emitLifecycle(this.options.services, 'app.stop', {
      deviceId: lifecycleRuntime(this.options.services)?.deviceId ?? null,
    });
    if (this.#lagTimer) clearTimeout(this.#lagTimer);
    this.#lagTimer = undefined;
    await Promise.allSettled(
      [...this.#shutdownHandlers].map((handler) => Promise.resolve().then(handler)),
    );
    await this.#localControl?.close();
    this.#localControl = undefined;
    for (const transport of [...this.#transportDisposers.keys()]) this.#detachTransport(transport);
    await this.#websocket?.close();
    this.#websocket = undefined;
    await this.options.services?.dispose();
    await this.#releaseLock?.();
    this.#releaseLock = undefined;
    this.#stopped = true;
  }

  attachTransport(transport: CoreTransport): () => void {
    if (!this.#started) throw new Error('Cannot attach a transport before the core is started');
    this.#attachTransport(transport);
    return () => {
      this.#detachTransport(transport);
    };
  }

  async handleMessage(raw: unknown, transport = this.options.transport): Promise<void> {
    const send = (message: unknown) => {
      if (!transport) return;
      try {
        transport.send(message);
      } catch {
        this.#detachTransport(transport);
      }
    };
    if (!this.#started) {
      send({
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
        send({
          jsonrpc: '2.0',
          id: null,
          error: rpcError(-32600, 'invalid_request', 'Empty JSON-RPC batch'),
        });
        return;
      }
      const responses = await Promise.all(raw.map((message) => this.#responseFor(message)));
      const present = responses.filter((response) => response !== undefined);
      if (present.length) send(present);
      return;
    }
    const response = await this.#responseFor(raw);
    if (response !== undefined) send(response);
  }

  #attachTransport(transport: CoreTransport): void {
    if (this.#transportDisposers.has(transport)) return;
    const unsubscribeMessages = transport.subscribe((message) => {
      void this.handleMessage(message, transport);
    });
    const unsubscribeEvents = this.onEvent((method, params) => {
      try {
        transport.send({ jsonrpc: '2.0', method, params });
      } catch {
        this.#detachTransport(transport);
      }
    });
    this.#transportDisposers.set(transport, () => {
      unsubscribeMessages();
      unsubscribeEvents();
      transport.close?.();
    });
  }

  #detachTransport(transport: CoreTransport): void {
    const dispose = this.#transportDisposers.get(transport);
    if (!dispose) return;
    this.#transportDisposers.delete(transport);
    dispose();
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
          : mapError(error, request.method);
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
        coreBusy: {
          busy: this.#eventLoopLagMs > 200 || this.#activeRpcMethods.size > 0,
          eventLoopLagMs: this.#eventLoopLagMs,
          activeRpcMethod: [...this.#activeRpcMethods.keys()].at(-1) ?? null,
        },
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
    const schema = FERRY_METHOD_PARAMS_SCHEMAS[request.method];
    this.#activeRpcMethods.set(
      request.method,
      (this.#activeRpcMethods.get(request.method) ?? 0) + 1,
    );
    try {
      if (schema) {
        const parsed = schema.safeParse(request.params ?? []);
        if (!parsed.success) throw new DispatchError(-32010, 'validation', parsed.error.message);
        return await handler(...parsed.data);
      }
      return await handler(...(request.params ?? []));
    } finally {
      const count = this.#activeRpcMethods.get(request.method) ?? 0;
      if (count <= 1) this.#activeRpcMethods.delete(request.method);
      else this.#activeRpcMethods.set(request.method, count - 1);
    }
  }

  #startLagMonitor(): void {
    let expected = performance.now() + 250;
    const tick = () => {
      if (!this.#started) return;
      const now = performance.now();
      this.#eventLoopLagMs = Math.max(0, now - expected);
      if (this.#eventLoopLagMs > 200 && !this.#lagWarningIssued) {
        this.#lagWarningIssued = true;
        this.options.services?.logger.warn(
          {
            lagMs: Math.round(this.#eventLoopLagMs),
            method: [...this.#activeRpcMethods.keys()].at(-1) ?? 'none',
          },
          'Core event loop lag exceeded 200 ms',
        );
      }
      expected = now + 250;
      this.#lagTimer = setTimeout(tick, 250);
      this.#lagTimer.unref();
    };
    this.#lagTimer = setTimeout(tick, 250);
    this.#lagTimer.unref();
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
    typeof existingLock.pid === 'number' &&
    Number.isSafeInteger(existingLock.pid) &&
    existingLock.pid > 1 &&
    existingLock.pid !== process.pid
  ) {
    try {
      process.kill(existingLock.pid, 0);
      throw new CoreLockError(canonicalizePath(options.dataDir));
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
      if (isLockContentionError(error)) return false;
      throw error;
    }
  } finally {
    await rm(recoveryPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isLockContentionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes(String(error.code));
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
    if (pid === process.pid) return false;
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1) {
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
    return JSON.parse(
      await readFile(resolve(canonicalizePath(dataDir), 'core.lock'), 'utf8'),
    ) as unknown;
  } catch {
    return null;
  }
}
