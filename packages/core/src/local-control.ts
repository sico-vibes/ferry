import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { rpcError } from '@ferry/shared';
import { canonicalPathKey } from '@ferry/shared/node-paths';
import type { CoreHost, CoreTransport } from './host.js';

const endpointFileName = 'core.endpoint.json';
const authMethod = 'ferry.local-auth';
const maxAuthLineBytes = 4096;
/** Requests into the core from an authenticated local client. */
const maxRpcLineBytes = 1_000_000;
/**
 * Replies from the core to its own client. Real data is large (providers.list carries every
 * provider's discovered model list, ~MBs with OpenRouter), and a 1 MB cap made `ferry run` fail
 * whenever the CLI attached to the running desktop engine.
 */
const maxResponseLineBytes = 64_000_000;

export interface LocalControlEndpoint {
  version: 1;
  transport: 'pipe' | 'unix';
  endpoint: string;
  token: string;
}

export interface LocalControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface LocalControlRpcTransport extends CoreTransport {
  onClose(handler: (reason?: Error) => void): () => void;
  reconnect(): Promise<void>;
}

export interface LocalControlStatus {
  state: 'available' | 'offline' | 'unavailable';
  pid?: number;
}

export function localControlEndpointPath(dataDir: string): string {
  return join(dataDir, endpointFileName);
}

export function localControlSocketAddress(
  dataDir: string,
  platform = process.platform,
): {
  transport: LocalControlEndpoint['transport'];
  endpoint: string;
} {
  if (platform !== 'win32') return { transport: 'unix', endpoint: join(dataDir, 'core.sock') };
  const scopedId = createHash('sha256')
    .update(canonicalPathKey(dataDir))
    .digest('hex')
    .slice(0, 24);
  return { transport: 'pipe', endpoint: `\\\\.\\pipe\\ferry-${scopedId}` };
}

export function verifyLocalControlToken(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return (
    expectedBytes.length > 0 &&
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export async function readLocalControlEndpoint(
  dataDir: string,
): Promise<LocalControlEndpoint | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(localControlEndpointPath(dataDir), 'utf8'));
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('version' in raw) ||
      raw.version !== 1 ||
      !('transport' in raw) ||
      (raw.transport !== 'pipe' && raw.transport !== 'unix') ||
      !('endpoint' in raw) ||
      typeof raw.endpoint !== 'string' ||
      !('token' in raw) ||
      typeof raw.token !== 'string' ||
      raw.token.length < 32
    )
      return undefined;
    return {
      version: 1,
      transport: raw.transport,
      endpoint: raw.endpoint,
      token: raw.token,
    };
  } catch {
    return undefined;
  }
}

export async function hasLocalControlEndpoint(dataDir: string): Promise<boolean> {
  return (await readLocalControlEndpoint(dataDir)) !== undefined;
}

export async function getLocalControlStatus(dataDir: string): Promise<LocalControlStatus> {
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(join(dataDir, 'core.lock'), 'utf8')) as unknown;
  } catch {
    return { state: 'offline' };
  }
  const pid = readLivePid(lock);
  if (pid === undefined) return { state: 'offline' };
  try {
    const transport = await connectLocalControl(dataDir);
    transport.close?.();
    return { state: 'available', pid };
  } catch {
    return { state: 'unavailable', pid };
  }
}

export async function connectLocalControl(dataDir: string): Promise<LocalControlRpcTransport> {
  const transport = new LocalControlClientTransport(dataDir);
  await transport.connect();
  return transport;
}

export async function startLocalControlServer(
  host: CoreHost,
  dataDir: string,
): Promise<LocalControlServer> {
  await mkdir(dataDir, { recursive: true });
  const address = localControlSocketAddress(dataDir);
  if (address.transport === 'unix') {
    await chmod(dataDir, 0o700);
    await rm(address.endpoint, { force: true });
  }

  const token = randomBytes(32).toString('hex');
  const endpoint: LocalControlEndpoint = {
    version: 1,
    transport: address.transport,
    endpoint: address.endpoint,
    token,
  };
  const connections = new Set<Socket>();
  const detachments = new Map<Socket, () => void>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.setNoDelay(true);
    let input = '';
    let authenticated = false;
    let handler: ((message: unknown) => void) | undefined;
    let detach: (() => void) | undefined;
    const authTimer = setTimeout(() => socket.destroy(), 5_000);
    authTimer.unref();

    const sendRaw = (message: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    const transport: CoreTransport = {
      send: sendRaw,
      subscribe(listener) {
        handler = listener;
        return () => {
          handler = undefined;
        };
      },
      close() {
        if (!socket.destroyed) socket.end();
      },
    };
    const disconnect = () => {
      clearTimeout(authTimer);
      connections.delete(socket);
      const remove = detachments.get(socket);
      detachments.delete(socket);
      remove?.();
      detach?.();
    };
    socket.on('close', disconnect);
    socket.on('error', disconnect);
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input, 'utf8') > (authenticated ? maxRpcLineBytes : maxAuthLineBytes)) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = input.indexOf('\n');
        if (newline < 0) break;
        const line = input.slice(0, newline).trim();
        input = input.slice(newline + 1);
        if (!line) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line) as unknown;
        } catch {
          if (!authenticated) {
            sendRaw({ type: authMethod, authenticated: false });
            socket.end();
          } else {
            sendRaw({
              jsonrpc: '2.0',
              id: null,
              error: rpcError(-32700, 'parse_error', 'Malformed JSON-RPC framing'),
            });
          }
          return;
        }
        if (!authenticated) {
          const supplied =
            typeof raw === 'object' && raw !== null && 'token' in raw ? raw.token : undefined;
          const accepted =
            typeof raw === 'object' &&
            raw !== null &&
            'type' in raw &&
            raw.type === authMethod &&
            verifyLocalControlToken(token, supplied);
          sendRaw({ type: authMethod, authenticated: accepted });
          if (!accepted) {
            socket.end();
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          detach = host.attachTransport(transport);
          detachments.set(socket, detach);
          continue;
        }
        handler?.(raw);
      }
    });
  });

  try {
    await listen(server, address.endpoint);
    if (address.transport === 'unix') await chmod(address.endpoint, 0o600);
    await writeEndpointFile(dataDir, endpoint);
  } catch (error) {
    for (const socket of connections) socket.destroy();
    await closeServer(server).catch(() => undefined);
    if (address.transport === 'unix') await rm(address.endpoint, { force: true });
    throw error;
  }

  let closed = false;
  return {
    endpoint: address.endpoint,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      await closeServer(server);
      if (address.transport === 'unix') await rm(address.endpoint, { force: true });
      const current = await readLocalControlEndpoint(dataDir);
      if (current?.token === token) await rm(localControlEndpointPath(dataDir), { force: true });
    },
  };
}

class LocalControlClientTransport implements LocalControlRpcTransport {
  readonly #dataDir: string;
  readonly #messageHandlers = new Set<(message: unknown) => void>();
  readonly #closeHandlers = new Set<(reason?: Error) => void>();
  #socket: Socket | undefined;
  #closed = false;
  #buffer = '';

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error('Local Ferry core transport is closed');
    const endpoint = await readLocalControlEndpoint(this.#dataDir);
    if (!endpoint) throw new Error('Local Ferry core endpoint is missing or invalid');
    const socket = await connectSocket(endpoint.endpoint);
    try {
      socket.write(`${JSON.stringify({ type: authMethod, token: endpoint.token })}\n`);
      const response = await readLine(socket, 5_000);
      const auth: unknown = JSON.parse(response);
      if (
        typeof auth !== 'object' ||
        auth === null ||
        !('type' in auth) ||
        auth.type !== authMethod ||
        !('authenticated' in auth) ||
        auth.authenticated !== true
      )
        throw new Error('Local Ferry core rejected authentication');
    } catch (error) {
      socket.destroy();
      throw error;
    }
    this.#socket = socket;
    this.#buffer = '';
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.#onData(socket, chunk);
    });
    socket.on('error', (error) => {
      this.#onClose(socket, error);
    });
    socket.on('close', () => {
      this.#onClose(socket, new Error('Local Ferry core connection closed'));
    });
  }

  send(message: unknown): void {
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error('Local Ferry core connection is closed');
    socket.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#onClose(socket, error);
    });
  }

  subscribe(handler: (message: unknown) => void): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onClose(handler: (reason?: Error) => void): () => void {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async reconnect(): Promise<void> {
    if (this.#closed) throw new Error('Local Ferry core transport is closed');
    const previous = this.#socket;
    this.#socket = undefined;
    previous?.destroy();
    await this.connect();
  }

  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.end();
    socket?.destroy();
    this.#messageHandlers.clear();
    this.#closeHandlers.clear();
  }

  #onData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.#socket) return;
    this.#buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.#buffer, 'utf8') > maxResponseLineBytes) {
      socket.destroy(new Error('Local Ferry core response exceeded the size limit'));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message: unknown = JSON.parse(line);
        for (const handler of this.#messageHandlers) handler(message);
      } catch (error) {
        this.#onClose(socket, error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
        return;
      }
    }
  }

  #onClose(socket: Socket, reason: Error): void {
    if (socket !== this.#socket) return;
    this.#socket = undefined;
    if (this.#closed) return;
    for (const handler of this.#closeHandlers) handler(reason);
  }
}

async function writeEndpointFile(dataDir: string, endpoint: LocalControlEndpoint): Promise<void> {
  const destination = localControlEndpointPath(dataDir);
  const temporary = `${destination}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  let installed = false;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(endpoint)}\n`,
      process.platform === 'win32'
        ? { encoding: 'utf8', flag: 'wx' }
        : { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await secureEndpointFile(temporary);
    await rm(destination, { force: true });
    await rename(temporary, destination);
    installed = true;
    await secureEndpointFile(destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (installed) await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function secureEndpointFile(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  // The Windows file inherits the per-user data directory's ACL.
  await chmod(path, 0o600);
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readLivePid(lock: unknown): number | undefined {
  if (
    typeof lock !== 'object' ||
    lock === null ||
    !('pid' in lock) ||
    typeof lock.pid !== 'number' ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 1
  )
    return undefined;
  try {
    process.kill(lock.pid, 0);
    return lock.pid;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM')
      return lock.pid;
    return undefined;
  }
}

function connectSocket(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Could not connect to the local Ferry core endpoint within 5 seconds'));
    }, 5_000);
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

function readLine(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      finish(new Error('Local Ferry core authentication timed out'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error, line?: string) => {
      cleanup();
      if (error) reject(error);
      else resolve(line ?? '');
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > maxAuthLineBytes) {
        finish(new Error('Local Ferry core authentication response was too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline >= 0) finish(undefined, buffer.slice(0, newline).trim());
    };
    const onError = (error: Error) => {
      finish(error);
    };
    const onClose = () => {
      finish(new Error('Local Ferry core closed during authentication'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}
