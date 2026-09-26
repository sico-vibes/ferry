import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { mapError, type CoreHost } from './host.js';
import { JsonRpcRequestSchema, rpcError } from '@ferry/shared';

export interface CoreWebSocketHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

function frame(payload: string, opcode = 1): Buffer {
  const body = Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function writeFailure(socket: Duplex, id: string | number | null, error: unknown): void {
  const mapped =
    typeof error === 'object' && error !== null && 'kind' in error && 'code' in error
      ? rpcError(
          error.code as number,
          String(error.kind),
          error instanceof Error ? error.message : 'Request failed',
        )
      : mapError(error);
  socket.write(frame(JSON.stringify({ jsonrpc: '2.0', id, error: mapped })));
}

export async function startCoreWebSocketServer(
  host: CoreHost,
  port = 0,
): Promise<CoreWebSocketHandle> {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Duplex>();
  const server: Server = createServer();
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ECONNRESET' || error.code === 'EPIPE')
      console.debug('WebSocket server disconnected');
    else console.error('WebSocket server error', error);
  });
  const offEvents = host.onEvent((method, params) => {
    const message = frame(JSON.stringify({ jsonrpc: '2.0', method, params }));
    for (const socket of sockets) if (!socket.destroyed) socket.write(message);
  });

  server.on('upgrade', (request, socket) => {
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE')
        console.debug('WebSocket client disconnected');
      else console.error('WebSocket socket error', error);
    });
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const supplied = Buffer.from(url.searchParams.get('token') ?? '');
    const expected = Buffer.from(token);
    const key = request.headers['sec-websocket-key'];
    const origin = request.headers.origin;
    if (
      url.pathname !== '/rpc' ||
      origin !== undefined ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      !key
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const firstByte = pending.readUInt8(0);
        const secondByte = pending.readUInt8(1);
        const opcode = firstByte & 0x0f;
        const masked = (secondByte & 0x80) !== 0;
        let length = secondByte & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 8) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 14) return;
          const bigLength = pending.readBigUInt64BE(2);
          if (bigLength > 1_000_000n) {
            socket.destroy();
            return;
          }
          length = Number(bigLength);
          offset = 10;
        }
        if (!masked || length > 1_000_000) {
          socket.destroy();
          return;
        }
        const frameEnd = offset + 4 + length;
        if (pending.length < frameEnd) return;
        const mask = pending.subarray(offset, offset + 4);
        const payload = Buffer.from(pending.subarray(offset + 4, frameEnd));
        for (let index = 0; index < payload.length; index++)
          payload[index] = payload.readUInt8(index) ^ mask.readUInt8(index % 4);
        pending = pending.subarray(frameEnd);
        if (opcode === 8) {
          socket.end(frame('', 8));
          return;
        }
        if (opcode === 9) {
          socket.write(frame(payload.toString(), 10));
          continue;
        }
        if (opcode !== 1) continue;
        void (async () => {
          let id: string | number | null = null;
          try {
            const raw: unknown = JSON.parse(payload.toString('utf8'));
            if (
              typeof raw === 'object' &&
              raw !== null &&
              'id' in raw &&
              (typeof raw.id === 'string' || typeof raw.id === 'number')
            )
              id = raw.id;
            const parsed = JsonRpcRequestSchema.safeParse(raw);
            if (!parsed.success) {
              socket.write(
                frame(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    error: rpcError(-32600, 'invalid_request', 'Invalid JSON-RPC request'),
                  }),
                ),
              );
              return;
            }
            const result = await host.dispatch(parsed.data, false);
            socket.write(frame(JSON.stringify({ jsonrpc: '2.0', id: parsed.data.id, result })));
          } catch (error) {
            writeFailure(socket, id, error);
          }
        })();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('WebSocket server did not bind a TCP port');
  return {
    url: `ws://127.0.0.1:${String(address.port)}/rpc?token=${token}`,
    token,
    close: async () => {
      offEvents();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
