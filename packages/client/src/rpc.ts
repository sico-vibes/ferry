import type { FerryClient } from './ferry-client.js';
import { FerryEventSchemas, type FerryEvents } from './events.js';
import {
  FERRY_PROTOCOL,
  type HelloResult,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from '@ferry/shared';

export interface RpcTransport {
  send(message: unknown): void;
  subscribe(handler: (message: unknown) => void): () => void;
  onClose?(handler: () => void): () => void;
  reconnect?(): Promise<void>;
  close?(): void;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly kind: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcFerryClient extends FerryClient {
  readonly hello: Promise<HelloResult>;
  readonly implementedMethods: ReadonlySet<string>;
  close(): void;
}

export function createRpcFerryClient(
  transport: RpcTransport,
  options: {
    timeoutMs?: number;
    reconnectAttempts?: number;
    onStatus?: (connected: boolean) => void;
  } = {},
): RpcFerryClient {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const reconnectAttempts = options.reconnectAttempts ?? 2;
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Map<keyof FerryEvents, Set<(payload: never) => void>>();
  const implementedMethods = new Set<string>();

  const offMessage = transport.subscribe((raw) => {
    if (typeof raw !== 'object' || raw === null) return;
    const message = raw as Partial<JsonRpcResponse & JsonRpcNotification> & {
      id?: number;
      method?: string;
      params?: unknown;
    };
    if (message.method && typeof message.id !== 'number') {
      const eventSchema = FerryEventSchemas[message.method as keyof FerryEvents];
      if (!eventSchema.safeParse(message.params).success) return;
      const handlers = listeners.get(message.method as keyof FerryEvents);
      if (handlers) for (const handler of handlers) handler(message.params as never);
      return;
    }
    if (typeof message.id !== 'number') return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    const response = message as JsonRpcResponse;
    if ('error' in response) {
      item.reject(
        new RpcError(
          response.error.message,
          response.error.code,
          response.error.data?.kind ?? 'internal',
          response.error.data?.details,
        ),
      );
    } else item.resolve(response.result);
  });
  const offClose = transport.onClose?.(() => {
    options.onStatus?.(false);
    if (closed) return;
    void reconnect();
  });

  async function reconnect() {
    if (!transport.reconnect) return;
    for (let attempt = 0; attempt < reconnectAttempts && !closed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      try {
        await transport.reconnect();
        options.onStatus?.(true);
        return;
      } catch {
        /* retry with capped exponential delay */
      }
    }
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new RpcError('Core connection was lost', -32000, 'unavailable'));
    }
    pending.clear();
  }

  async function request(method: string, params: unknown[] = []): Promise<unknown> {
    if (closed) throw new RpcError('RPC client is closed', -32000, 'unavailable');
    const id = ++nextId;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcError(`RPC request timed out: ${method}`, -32001, 'timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  const hello = request('system.hello', [
    { protocol: FERRY_PROTOCOL, capabilities: ['events', 'selfTest'] },
  ]).then((raw) => {
    const result = raw as HelloResult;
    for (const method of result.implementedMethods) implementedMethods.add(method);
    return result;
  });
  const domainObjects = new Map<string, object>();
  const client = new Proxy(
    {
      close() {
        closed = true;
        offMessage();
        offClose?.();
        transport.close?.();
      },
    },
    {
      get(target, key) {
        if (key === 'hello') return hello;
        if (key === 'implementedMethods') return implementedMethods;
        if (key === 'close')
          return () => {
            target.close();
          };
        if (key === 'on')
          return <E extends keyof FerryEvents>(
            event: E,
            handler: (payload: FerryEvents[E]) => void,
          ) => {
            const set = listeners.get(event) ?? new Set<(payload: never) => void>();
            set.add(handler);
            listeners.set(event, set);
            return () => {
              set.delete(handler);
            };
          };
        if (typeof key !== 'string') return undefined;
        let domain = domainObjects.get(key);
        if (!domain) {
          domain = new Proxy(
            {},
            {
              get: (_domain, method) =>
                typeof method === 'string'
                  ? (...args: unknown[]) => request(`${key}.${method}`, args)
                  : undefined,
            },
          );
          domainObjects.set(key, domain);
        }
        return domain;
      },
    },
  );
  options.onStatus?.(true);
  return client as RpcFerryClient;
}

export function createMessagePortTransport(
  initialPort: MessagePort,
  options: {
    reconnect?: () => Promise<MessagePort>;
    onRestarting?: (handler: () => void) => () => void;
  } = {},
): RpcTransport {
  let port = initialPort;
  const messageHandlers = new Set<(message: unknown) => void>();
  const closeHandlers = new Set<() => void>();
  const attach = (candidate: MessagePort) => {
    candidate.start();
    candidate.addEventListener('message', (event) => {
      for (const handler of messageHandlers) handler(event.data);
    });
    candidate.addEventListener('messageerror', () => {
      for (const handler of closeHandlers) handler();
    });
  };
  attach(port);
  const offRestarting = options.onRestarting?.(() => {
    for (const handler of closeHandlers) handler();
  });
  const reconnect = options.reconnect;
  return {
    send: (message) => {
      port.postMessage(message);
    },
    subscribe(handler) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    ...(reconnect
      ? {
          reconnect: async () => {
            port.close();
            port = await reconnect();
            attach(port);
          },
        }
      : {}),
    close() {
      offRestarting?.();
      port.close();
      messageHandlers.clear();
      closeHandlers.clear();
    },
  };
}

export interface HybridFerryClient extends FerryClient {
  setRealDomains(domains: readonly string[]): void;
  getRealDomains(): string[];
}
export function createHybridClient(
  mock: FerryClient,
  rpc: FerryClient,
  realDomains: readonly string[],
): HybridFerryClient {
  const real = new Set(realDomains);
  const proxy = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'then') return undefined;
        if (key === 'setRealDomains')
          return (domains: readonly string[]) => {
            real.clear();
            for (const domain of domains) real.add(domain);
          };
        if (key === 'getRealDomains') return () => [...real];
        if (key === 'on')
          return <E extends keyof FerryEvents>(
            event: E,
            handler: (payload: FerryEvents[E]) => void,
          ) => {
            const domain =
              event.startsWith('session.') || event === 'task.updated'
                ? 'sessions'
                : event === 'settings.updated'
                  ? 'settings'
                  : event.startsWith('workspace.')
                    ? 'workspaces'
                    : event === 'approval.request'
                      ? 'sessions'
                      : event === 'mcp.status'
                        ? 'mcp'
                        : event === 'quota.updated'
                          ? 'quota'
                          : event === 'provider.updated'
                            ? 'providers'
                            : event === 'delegation.updated'
                              ? 'delegation'
                              : event === 'workspace.updated'
                                ? 'workspaces'
                                : '';
            return (real.has(domain) ? rpc : mock).on(event, handler);
          };
        if (typeof key !== 'string') return undefined;
        const source = key === 'system' || real.has(key) ? rpc : mock;
        const domain = Reflect.get(source, key) as object;
        return new Proxy(domain, {
          get(target, method) {
            const value: unknown = Reflect.get(target, method);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]): unknown => {
              const result: unknown = Reflect.apply(value, target, args);
              if (key === 'settings' && method === 'update')
                return Promise.resolve(result).then((settings: unknown) => {
                  if (
                    typeof settings === 'object' &&
                    settings !== null &&
                    'developer' in settings &&
                    typeof settings.developer === 'object' &&
                    settings.developer !== null &&
                    'realDomains' in settings.developer &&
                    Array.isArray(settings.developer.realDomains)
                  ) {
                    real.clear();
                    for (const domain of settings.developer.realDomains)
                      if (typeof domain === 'string') real.add(domain);
                  }
                  return settings;
                });
              return result;
            };
          },
        });
      },
    },
  );
  return proxy as HybridFerryClient;
}

export function createStdioRpcTransport(
  input: { on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown },
  output: { write(chunk: string): unknown },
): RpcTransport {
  let receiver: ((message: unknown) => void) | undefined;
  let buffer = '';
  input.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          receiver?.(JSON.parse(line) as unknown);
        } catch {
          /* malformed lines are ignored by the client transport */
        }
      }
    }
  });
  return {
    send(message) {
      output.write(`${JSON.stringify(message)}\n`);
    },
    subscribe(handler) {
      receiver = handler;
      return () => {
        receiver = undefined;
      };
    },
  };
}

export function createWebSocketRpcTransport(url: string): RpcTransport {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    !endpoint.searchParams.get('token')
  ) {
    throw new Error('Ferry WebSocket RPC requires a loopback URL with a bearer token');
  }
  const handlers = new Set<(message: unknown) => void>();
  const closeHandlers = new Set<() => void>();
  const queued: string[] = [];
  let socket: WebSocket;
  let ready: Promise<void>;
  const connect = () => {
    socket = new WebSocket(endpoint.toString());
    ready = new Promise((resolve, reject) => {
      socket.addEventListener(
        'open',
        () => {
          while (queued.length) {
            const payload = queued.shift();
            if (payload !== undefined) socket.send(payload);
          }
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          reject(new Error('Ferry WebSocket connection failed'));
        },
        { once: true },
      );
    });
    socket.addEventListener('message', (event) => {
      try {
        const message: unknown = JSON.parse(String(event.data));
        for (const handler of handlers) handler(message);
      } catch {
        /* malformed frames do not reach client callbacks */
      }
    });
    socket.addEventListener('close', () => {
      for (const handler of closeHandlers) handler();
    });
    return ready;
  };
  void connect().catch(() => undefined);
  return {
    send(message) {
      const payload = JSON.stringify(message);
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      else queued.push(payload);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    async reconnect() {
      socket.close();
      await connect();
    },
    close() {
      socket.close();
      handlers.clear();
      closeHandlers.clear();
    },
  };
}
