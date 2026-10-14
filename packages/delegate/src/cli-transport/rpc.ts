/** JSON-RPC error surfaced by the peer; `code` follows JSON-RPC conventions (-32601 = no method). */
export class JsonRpcRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcRequestError';
    this.code = code;
    this.data = data;
  }
}

/** Unrecoverable framing failure (oversized line/buffer or malformed JSON). */
export class JsonRpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcProtocolError';
  }
}

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

type RequestId = string | number;

interface PeerOptions {
  write: (line: string) => void;
  maxLineBytes?: number;
  maxBufferedBytes?: number;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: JsonRpcServerRequest) => void;
  onProtocolError?: (error: Error) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * Minimal headerless NDJSON JSON-RPC 2.0 peer with bounded framing. Handles client→server requests,
 * client notifications, and inbound server requests/notifications. Never logs credentials.
 */
export class NdjsonJsonRpcPeer {
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly maxLineBytes: number;
  private readonly maxBufferedBytes: number;

  constructor(private readonly options: PeerOptions) {
    this.maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 32 * 1024 * 1024;
  }

  handleChunk(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > this.maxBufferedBytes) {
      this.fail(new JsonRpcProtocolError('CLI protocol buffer exceeded its bound'));
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) this.handleLine(line);
      if (this.isClosed()) return;
    }
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private handleLine(line: string): void {
    if (line.length > this.maxLineBytes) {
      this.fail(new JsonRpcProtocolError('CLI emitted an oversized protocol frame'));
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.fail(new JsonRpcProtocolError('CLI emitted a malformed protocol frame'));
      return;
    }
    if (!isRecord(frame)) return;
    const { id, method } = frame;
    if (typeof method === 'string') {
      if (method === '') return;
      if (id === undefined || id === null) {
        this.options.onNotification?.(method, frame.params);
      } else if (isRequestId(id)) {
        this.options.onServerRequest?.({ id, method, params: frame.params });
      }
      return;
    }
    if (!isRequestId(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (isRecord(frame.error)) {
      const code = typeof frame.error.code === 'number' ? frame.error.code : -32000;
      const message = typeof frame.error.message === 'string' ? frame.error.message : 'CLI error';
      pending.reject(new JsonRpcRequestError(code, message, frame.error.data));
    } else {
      pending.resolve(frame.result);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CLI connection is closed'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  respondResult(id: RequestId, result: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.options.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values())
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    this.pending.clear();
    this.options.onProtocolError?.(error);
  }

  /** Stop accepting input and reject in-flight requests. */
  close(reason = 'CLI connection closed'): void {
    this.fail(new Error(reason));
  }
}
