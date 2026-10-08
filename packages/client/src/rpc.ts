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
  onClose?(handler: (reason?: RpcError) => void): () => void;
  reconnect?(): Promise<void>;
  close?(): void;
}

export interface MessagePortConnection {
  port: MessagePort;
  portId: string;
}

export interface MessagePortTransportDiagnostic {
  event: 'attached' | 'restarting' | 'queued' | 'sent' | 'received' | 'reconnected';
  generation: number;
  portId: string;
  requestId?: number;
  method?: string;
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
  sessions: FerryClient['sessions'] & {
    start(input: {
      workspaceId?: import('@ferry/shared').WorkspaceId | null;
      profileId?: import('@ferry/shared').ProfileId;
      modelRef?: import('@ferry/shared').ModelRef | 'auto';
      effort?: import('@ferry/shared').Effort | null;
      text: string;
      attachments?: { name: string; text: string }[];
    }): Promise<import('@ferry/shared').Session>;
  };
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
      if (!Object.hasOwn(FerryEventSchemas, message.method)) return;
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
  const offClose = transport.onClose?.((reason) => {
    options.onStatus?.(false);
    if (reason) {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(reason);
      }
      pending.clear();
    }
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
  initialConnection: MessagePort | MessagePortConnection,
  options: {
    reconnect?: () => Promise<MessagePort | MessagePortConnection>;
    onRestarting?: (handler: () => void) => () => void;
    onReconnected?: () => void;
    onDiagnostic?: (diagnostic: MessagePortTransportDiagnostic) => void;
  } = {},
): RpcTransport {
  const asConnection = (connection: MessagePort | MessagePortConnection): MessagePortConnection =>
    'port' in connection && 'portId' in connection
      ? connection
      : { port: connection, portId: 'untracked' };
  let connection = asConnection(initialConnection);
  let port = connection.port;
  let generation = 0;
  let reconnecting = false;
  let reconnectPromise: Promise<void> | undefined;
  const queuedMessages: unknown[] = [];
  const requestMethods = new Map<number, string>();
  const messageHandlers = new Set<(message: unknown) => void>();
  const closeHandlers = new Set<(reason?: RpcError) => void>();
  const markRestarting = () => {
    if (reconnecting) return;
    reconnecting = true;
    options.onDiagnostic?.({ event: 'restarting', generation, portId: connection.portId });
    const reason = new RpcError(
      'Core restarted while the request was pending',
      -32002,
      'core_restarted',
    );
    for (const handler of closeHandlers) handler(reason);
  };
  const attach = (candidate: MessagePortConnection) => {
    connection = candidate;
    port = candidate.port;
    generation += 1;
    options.onDiagnostic?.({ event: 'attached', generation, portId: connection.portId });
    candidate.port.start();
    candidate.port.addEventListener('message', (event) => {
      const message = event.data as { id?: unknown; method?: unknown } | null;
      const requestId = typeof message?.id === 'number' ? message.id : undefined;
      const method =
        typeof message?.method === 'string'
          ? message.method
          : requestId === undefined
            ? undefined
            : requestMethods.get(requestId);
      if (requestId !== undefined || method !== undefined) {
        options.onDiagnostic?.({
          event: 'received',
          generation,
          portId: connection.portId,
          ...(requestId !== undefined ? { requestId } : {}),
          ...(method !== undefined ? { method } : {}),
        });
        if (requestId !== undefined) requestMethods.delete(requestId);
      }
      for (const handler of messageHandlers) handler(event.data);
    });
    candidate.port.addEventListener('messageerror', markRestarting);
  };
  attach(connection);
  const offRestarting = options.onRestarting?.(markRestarting);
  const reconnect = options.reconnect;
  return {
    send: (message) => {
      const request = message as { id?: unknown; method?: unknown } | null;
      const details = {
        ...(typeof request?.id === 'number' ? { requestId: request.id } : {}),
        ...(typeof request?.method === 'string' ? { method: request.method } : {}),
      };
      if (typeof request?.id === 'number' && typeof request.method === 'string')
        requestMethods.set(request.id, request.method);
      if (reconnecting) {
        queuedMessages.push(message);
        options.onDiagnostic?.({
          event: 'queued',
          generation,
          portId: connection.portId,
          ...details,
        });
        return;
      }
      port.postMessage(message);
      options.onDiagnostic?.({ event: 'sent', generation, portId: connection.portId, ...details });
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
          reconnect: () => {
            if (reconnectPromise) return reconnectPromise;
            reconnectPromise = (async () => {
              port.close();
              attach(asConnection(await reconnect()));
              reconnecting = false;
              for (const message of queuedMessages.splice(0)) {
                port.postMessage(message);
                const request = message as { id?: unknown; method?: unknown } | null;
                options.onDiagnostic?.({
                  event: 'sent',
                  generation,
                  portId: connection.portId,
                  ...(typeof request?.id === 'number' ? { requestId: request.id } : {}),
                  ...(typeof request?.method === 'string' ? { method: request.method } : {}),
                });
              }
              options.onDiagnostic?.({
                event: 'reconnected',
                generation,
                portId: connection.portId,
              });
              options.onReconnected?.();
            })().finally(() => {
              reconnectPromise = undefined;
            });
            return reconnectPromise;
          },
        }
      : {}),
    close() {
      offRestarting?.();
      reconnecting = false;
      queuedMessages.length = 0;
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

/** Select the renderer client while keeping Electron entirely on the engine RPC transport. */
export function createRendererFerryClient(
  mock: FerryClient,
  rpc: FerryClient,
  isElectron: boolean,
  realDomains: readonly string[],
): FerryClient {
  return isElectron ? rpc : createHybridClient(mock, rpc, realDomains);
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
                        : event.startsWith('quota.')
                          ? 'quota'
                          : event === 'provider.updated' || event === 'providers.health.updated'
                            ? 'providers'
                            : event === 'delegation.updated'
                              ? 'delegation'
                              : event === 'oauth.progress'
                                ? 'oauth'
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
      socket.addEventListener('error', () => {
        reject(new Error('Ferry WebSocket connection failed'));
      });
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
