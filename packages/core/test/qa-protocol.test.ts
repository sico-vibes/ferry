import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createRpcFerryClient } from '@ferry/client';
import {
  FERRY_PROTOCOL,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  SettingsSchema,
  type JsonRpcResponse,
} from '@ferry/shared';
import { DEFAULT_SETTINGS } from '@ferry/config';
import { CoreHost, createMemoryTransportPair, createStdioTransport } from '../src/index.js';
import type { CoreTransport } from '../src/index.js';

const dataDir = await mkdtemp(join(tmpdir(), 'ferry-qa-protocol-'));
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

interface Wire {
  transport: CoreTransport;
  sent: unknown[];
  inject(message: unknown): void;
  drain(): Promise<void>;
}

function createWire(): Wire {
  const sent: unknown[] = [];
  let listener: ((message: unknown) => void) | undefined;
  return {
    transport: {
      send: (message) => sent.push(message),
      subscribe: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    },
    sent,
    inject: (message) => listener?.(message),
    async drain() {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

function lastResponse(wire: Wire): JsonRpcResponse {
  const raw = wire.sent.at(-1);
  const parsed = JsonRpcResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`No JSON-RPC response was sent: ${JSON.stringify(raw)}`);
  return parsed.data;
}

async function startHost(name: string): Promise<{ host: CoreHost; wire: Wire }> {
  const wire = createWire();
  const host = new CoreHost({ dataDir: join(dataDir, name), transport: wire.transport });
  await host.start();
  return { host, wire };
}

async function poll(check: () => boolean, timeoutMs = 400): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

describe('QA protocol envelope', () => {
  it('rejects malformed JSON-RPC envelopes with invalid_request (-32600)', async () => {
    const { host, wire } = await startHost('envelope');
    const cases: unknown[] = [
      { id: 1, method: 'system.info', params: [] },
      { jsonrpc: '1.0', id: 2, method: 'system.info', params: [] },
      { jsonrpc: '2.0', id: 3, params: [] },
      { jsonrpc: '2.0', id: 4, method: 'not a method', params: [] },
      { jsonrpc: '2.0', id: 5, method: 'system.info', params: 'nope' },
      { jsonrpc: '2.0', id: 6, method: 'system.info', params: { a: 1 } },
      { jsonrpc: '2.0', id: null, method: 'system.info', params: [] },
      { jsonrpc: '2.0', id: {}, method: 'system.info', params: [] },
      { jsonrpc: '2.0', id: true, method: 'system.info', params: [] },
    ];
    for (const message of cases) {
      wire.sent.length = 0;
      wire.inject(message);
      await wire.drain();
      const response = lastResponse(wire);
      expect(response, JSON.stringify(message)).toMatchObject({
        error: { code: -32600, data: { kind: 'invalid_request' } },
      });
    }
    await host.stop();
    await host.handleMessage({ jsonrpc: '2.0', id: 3, method: 'system.info', params: [] });
    expect(lastResponse(wire)).toMatchObject({
      id: 3,
      error: { data: { kind: 'shutting_down' } },
    });
  });

  // BUG: a fractional numeric id is echoed back verbatim, producing a response
  // that the exported JsonRpcResponseSchema itself rejects (ids must be integers
  // or strings); it should fall back to null like other unusable ids.
  it('does not echo a fractional id that fails its own response schema', async () => {
    const { host, wire } = await startHost('fractional-id');
    wire.inject({ jsonrpc: '2.0', id: 1.5, method: 'system.info', params: [] });
    await wire.drain();
    expect(JsonRpcResponseSchema.safeParse(wire.sent.at(-1)).success).toBe(true);
    await host.stop();
  });

  it('echoes the numeric/string id of an invalid envelope and null for unusable ids', async () => {
    const { host, wire } = await startHost('ids');
    wire.inject({ jsonrpc: '2.0', id: 'abc', method: 'bad method', params: [] });
    await wire.drain();
    expect(lastResponse(wire)).toMatchObject({ id: 'abc', error: { code: -32600 } });

    wire.inject({ jsonrpc: '2.0', id: 7, method: 'bad method', params: [] });
    await wire.drain();
    expect(lastResponse(wire)).toMatchObject({ id: 7, error: { code: -32600 } });

    wire.inject({ jsonrpc: '2.0', id: true, method: 'bad method', params: [] });
    await wire.drain();
    expect(lastResponse(wire)).toMatchObject({ id: null, error: { code: -32600 } });
    await host.stop();
  });

  it('distinguishes unknown methods (-32601) from known unimplemented methods (-32004)', async () => {
    const { host, wire } = await startHost('methods');
    wire.inject({ jsonrpc: '2.0', id: 1, method: 'nope.thing', params: [] });
    await wire.drain();
    expect(lastResponse(wire)).toMatchObject({
      error: { code: -32601, data: { kind: 'unknown_method' } },
    });

    wire.inject({ jsonrpc: '2.0', id: 2, method: 'sessions.send', params: [] });
    await wire.drain();
    expect(lastResponse(wire)).toMatchObject({
      error: { code: -32004, data: { kind: 'not_implemented' } },
    });

    wire.inject({ jsonrpc: '2.0', id: 3, method: 'sessions.noSuchMethod', params: [] });
    await wire.drain();
    expect(lastResponse(wire)).toMatchObject({ error: { code: -32601 } });
    await host.stop();
  });

  it('ignores notifications (no id) without replying', async () => {
    const { host, wire } = await startHost('notify');
    wire.inject({ jsonrpc: '2.0', method: 'system.info', params: [] });
    await wire.drain();
    expect(wire.sent).toHaveLength(0);
    await host.stop();
  });

  it('accepts concurrent requests and answers each id exactly once, even when reordered', async () => {
    const { host, wire } = await startHost('reorder');
    wire.inject({ jsonrpc: '2.0', id: 10, method: 'system.info', params: [] });
    wire.inject({ jsonrpc: '2.0', id: 11, method: 'system.selfTest', params: [] });
    wire.inject({ jsonrpc: '2.0', id: 12, method: 'system.hello', params: [] });
    await wire.drain();
    const byId = new Map(
      wire.sent
        .map((raw) => JsonRpcResponseSchema.safeParse(raw))
        .filter((result) => result.success)
        .map((result) => [result.data.id, result.data]),
    );
    expect(byId.size).toBe(3);
    expect(byId.get(10)).toMatchObject({ id: 10 });
    expect(byId.get(11)).toMatchObject({ id: 11 });
    expect((byId.get(12) as { error?: unknown } | undefined)?.error).toMatchObject({
      code: -32002,
    });
    const ids = wire.sent.map((raw) => (raw as { id?: unknown }).id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    await host.stop();
  });

  it('stops accepting requests once stopped', async () => {
    const { host, wire } = await startHost('stopped');
    wire.inject({ jsonrpc: '2.0', id: 1, method: 'system.info', params: [] });
    await wire.drain();
    expect(wire.sent).toHaveLength(1);
    await host.stop();
    wire.sent.length = 0;
    wire.inject({ jsonrpc: '2.0', id: 2, method: 'system.info', params: [] });
    await wire.drain();
    expect(wire.sent).toHaveLength(0);
  });

  // BUG: every start() adds another permanent event forwarder; stop() never
  // unsubscribes it, so a stop/start cycle delivers each event twice.
  it('emits each event exactly once after a stop/start cycle', async () => {
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const settings = SettingsSchema.parse(DEFAULT_SETTINGS);
    const host = new CoreHost({
      dataDir: join(dataDir, 'restart-events'),
      transport: coreTransport,
    });
    host.registerDomain('settings', {
      get() {
        host.emit('settings.updated', settings);
        return settings;
      },
    });
    await host.start();
    const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 2000 });
    await rpc.hello;
    await host.stop();
    await host.start();
    let count = 0;
    rpc.on('settings.updated', () => {
      count++;
    });
    await rpc.settings.get();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(count).toBe(1);
    rpc.close();
    await host.stop();
  });

  it('reports a clear error when a composed host is started after stop', async () => {
    const host = new CoreHost({
      dataDir: join(dataDir, 'composed-restart'),
      services: { dispose: () => Promise.resolve() } as never,
    });
    await host.start();
    await host.stop();
    await expect(host.start()).rejects.toThrow(/already_stopped/);
  });

  // BUG: JSON-RPC batch requests (an array) are silently dropped instead of being
  // answered with an array of responses (or a single invalid_request).
  it('answers a JSON-RPC batch request', async () => {
    const { host, wire } = await startHost('batch');
    wire.inject([
      { jsonrpc: '2.0', id: 1, method: 'system.info', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'system.info', params: [] },
    ]);
    await wire.drain();
    expect(wire.sent.length).toBeGreaterThan(0);
    expect(wire.sent[0]).toHaveLength(2);
    wire.sent.length = 0;
    wire.inject([]);
    await wire.drain();
    expect(lastResponse(wire)).toMatchObject({
      id: null,
      error: { code: -32600, data: { kind: 'invalid_request' } },
    });
    await host.stop();
  });
});

describe('QA stdio framing', () => {
  it('round-trips a large (multi-frame) payload without truncation', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    const host = new CoreHost({
      dataDir: join(dataDir, 'huge'),
      transport: createStdioTransport(input, output),
    });
    await host.start();
    const big = 'x'.repeat(1_200_000);
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.selfTest', params: [big] })}\n`,
    );
    await poll(() => lines.join('').includes('\n'));
    const response = JsonRpcResponseSchema.parse(JSON.parse(lines.join('').trim()));
    expect(response).toMatchObject({ id: 1, result: { modules: [] } });
    await host.stop();
  });

  // BUG: malformed JSON on the stdio framing is swallowed with no parse_error (-32700)
  // response, leaving the client to time out.
  it('reports malformed JSON framing with parse_error (-32700)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    const host = new CoreHost({
      dataDir: join(dataDir, 'malformed'),
      transport: createStdioTransport(input, output),
    });
    await host.start();
    input.write('this is not json\n');
    await poll(() => lines.join('').trim().length > 0);
    expect(JSON.parse(lines.join('').trim())).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, data: { kind: 'parse_error' } },
    });
    await host.stop();
  });
});

describe('QA request schema parity', () => {
  it('keeps the exported request schema aligned with the dispatcher id rules', () => {
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'a.b' }).success).toBe(
      true,
    );
    expect(
      JsonRpcRequestSchema.safeParse({ jsonrpc: FERRY_PROTOCOL, id: 1, method: 'a.b' }).success,
    ).toBe(false);
    expect(
      JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'a.b', params: {} }).success,
    ).toBe(false);
  });
});
