import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  RpcError,
  createRpcFerryClient,
  createWebSocketRpcTransport,
  type RpcFerryClient,
} from '@ferry/client';
import { CoreHost, createCoreHost } from '../src/index.js';
import type { CoreWebSocketHandle } from '../src/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-qa-ws-'));
const active: CoreHost[] = [];

afterEach(async () => {
  while (active.length) await active.pop()?.stop();
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function startBareWs(
  name: string,
): Promise<{ host: CoreHost; endpoint: CoreWebSocketHandle }> {
  const host = new CoreHost({
    dataDir: join(dataDir, name),
    websocketEnabled: true,
  });
  active.push(host);
  await host.start();
  const endpoint = host.websocket;
  if (!endpoint) throw new Error('WebSocket endpoint did not start');
  return { host, endpoint };
}

async function upgradeStatus(
  port: number,
  requestPath: string,
  options: { origin?: string; key?: string } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
      ];
      if (options.key !== undefined) lines.push(`Sec-WebSocket-Key: ${options.key}`);
      if (options.origin) lines.push(`Origin: ${options.origin}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('TIMEOUT');
    }, 2000);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(buffer.split('\r\n')[0] ?? buffer);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function portOf(endpoint: CoreWebSocketHandle): number {
  return Number(new URL(endpoint.url).port);
}

async function readAllLogs(logsDir: string): Promise<string> {
  let output = '';
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return output;
  }
  for (const entry of entries) {
    try {
      output += await readFile(join(logsDir, entry), 'utf8');
    } catch {
      /* non-file entry */
    }
  }
  return output;
}

describe('QA WebSocket transport validation', () => {
  it('rejects non-loopback URLs and URLs without a bearer token', () => {
    expect(() => createWebSocketRpcTransport('ws://127.0.0.1:9999/rpc')).toThrow(/token/i);
    expect(() => createWebSocketRpcTransport('ws://example.com/rpc?token=abc')).toThrow(
      /loopback/i,
    );
    expect(() => createWebSocketRpcTransport('http://127.0.0.1:9999/rpc?token=abc')).toThrow(
      /loopback/i,
    );
  });

  it('accepts the negotiated handshake with the correct token', async () => {
    const { endpoint } = await startBareWs('ws-valid');
    const url = new URL(endpoint.url);
    const status = await upgradeStatus(
      portOf(endpoint),
      `${url.pathname}?token=${endpoint.token}`,
      {
        key: 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    );
    expect(status).toContain('101');
  });

  it('rejects a missing, wrong, or malformed token with 401', async () => {
    const { endpoint } = await startBareWs('ws-token');
    const url = new URL(endpoint.url);
    expect(await upgradeStatus(portOf(endpoint), url.pathname, { key: 'a2V5' })).toContain('401');
    expect(
      await upgradeStatus(portOf(endpoint), `${url.pathname}?token=deadbeef`, { key: 'a2V5' }),
    ).toContain('401');
    expect(
      await upgradeStatus(portOf(endpoint), `${url.pathname}?token=${endpoint.token}xx`, {
        key: 'a2V5',
      }),
    ).toContain('401');
  });

  it('rejects the wrong path and a missing Sec-WebSocket-Key', async () => {
    const { endpoint } = await startBareWs('ws-path');
    expect(
      await upgradeStatus(portOf(endpoint), `/not-rpc?token=${endpoint.token}`, { key: 'a2V5' }),
    ).toContain('401');
    expect(
      await upgradeStatus(
        portOf(endpoint),
        `${new URL(endpoint.url).pathname}?token=${endpoint.token}`,
      ),
    ).toContain('401');
  });

  it('round-trips hello over an authenticated WebSocket', async () => {
    const { endpoint } = await startBareWs('ws-rpc');
    const rpc: RpcFerryClient = createRpcFerryClient(createWebSocketRpcTransport(endpoint.url), {
      timeoutMs: 3000,
    });
    try {
      await expect(rpc.hello).resolves.toMatchObject({ protocol: 'ferry/1' });
      await expect(rpc.system.info()).resolves.toMatchObject({ mock: false });
    } finally {
      rpc.close();
    }
  });

  it('rejects rather than hangs when the token is wrong', async () => {
    const { endpoint } = await startBareWs('ws-wrong');
    const wrong = new URL(endpoint.url);
    wrong.searchParams.set('token', 'wrong-token');
    const rpc = createRpcFerryClient(createWebSocketRpcTransport(wrong.toString()), {
      timeoutMs: 1500,
    });
    try {
      await expect(rpc.hello).rejects.toBeInstanceOf(RpcError);
    } finally {
      rpc.close();
    }
  });

  it('still requires a valid token even with a spoofed browser Origin', async () => {
    const { endpoint } = await startBareWs('ws-origin');
    const url = new URL(endpoint.url);
    // Token missing + hostile Origin must be refused.
    expect(
      await upgradeStatus(portOf(endpoint), url.pathname, {
        key: 'a2V5',
        origin: 'http://evil.example',
      }),
    ).toContain('401');
    // Observed: the server does not enforce the Origin header, so a caller that
    // somehow learns the random token can connect from any Origin. Recorded as a
    // hardening risk, not a spec violation (loopback + bearer token is the gate).
    expect(
      await upgradeStatus(portOf(endpoint), `${url.pathname}?token=${endpoint.token}`, {
        key: 'a2V5',
        origin: 'http://evil.example',
      }),
    ).toContain('101');
  });
});

describe('QA WebSocket token secrecy', () => {
  it('never writes the bearer token to console output or the core logs', async () => {
    const consoleSpy = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const dir = join(dataDir, 'ws-secret');
    const host = await createCoreHost({ dataDir: dir, websocketEnabled: true });
    active.push(host);
    const endpoint = host.websocket;
    if (!endpoint) throw new Error('WebSocket endpoint did not start');
    const rpc = createRpcFerryClient(createWebSocketRpcTransport(endpoint.url), {
      timeoutMs: 3000,
    });
    try {
      await rpc.hello;
      await rpc.system.info();
    } finally {
      rpc.close();
      await host.stop();
    }
    const printed = consoleSpy
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((value) => String(value))
      .join('\n');
    consoleSpy.forEach((spy) => {
      spy.mockRestore();
    });
    expect(printed).not.toContain(endpoint.token);
    const logs = await readAllLogs(join(dir, 'logs'));
    expect(logs).not.toContain(endpoint.token);
  });
});
