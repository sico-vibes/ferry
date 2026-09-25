import { describe, expect, it } from 'vitest';
import { createMockFerryClient } from '../src/index.js';
import { createHybridClient, createRpcFerryClient, type RpcTransport } from '../src/rpc.js';
import { runFerryClientContract } from '../src/testing/contract.js';
import { createFakeClock } from '../src/mock/clock.js';

function fakeTransport(): {
  transport: RpcTransport;
  receive(message: unknown): void;
  requests: unknown[];
} {
  let listener: ((message: unknown) => void) | undefined;
  const requests: unknown[] = [];
  return {
    transport: {
      send: (message) => {
        requests.push(message);
      },
      subscribe: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    },
    receive: (message) => listener?.(message),
    requests,
  };
}

runFerryClientContract('HybridClient all-mock', () => {
  const fake = createFakeClock(new Date('2026-09-23T21:47:00.000Z'));
  const mock = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
  return Promise.resolve({
    client: createHybridClient(mock, mock, []),
    advance: (ms) => {
      fake.advance(ms);
      return Promise.resolve();
    },
  });
});

describe('RPC client', () => {
  it('maps calls to JSON-RPC and delivers event subscriptions', async () => {
    const fake = fakeTransport();
    const client = createRpcFerryClient(fake.transport);
    const hello = fake.requests[0] as { id: number };
    fake.receive({
      jsonrpc: '2.0',
      id: hello.id,
      result: { protocol: 'ferry/1', capabilities: [], realDomains: [], implementedMethods: [] },
    });
    await client.hello;
    const pending = client.system.info();
    const call = fake.requests.at(-1) as { id: number; method: string; params: unknown[] };
    expect(call).toMatchObject({ method: 'system.info', params: [] });
    fake.receive({
      jsonrpc: '2.0',
      id: call.id,
      result: { version: '0.1.0', mock: false, platform: 'win32' },
    });
    expect((await pending).mock).toBe(false);
    let value = '';
    client.on('session.delta', (event) => {
      value = event.textDelta;
    });
    fake.receive({
      jsonrpc: '2.0',
      method: 'session.delta',
      params: { sessionId: 's1', messageId: 'm1', partId: 'p1', textDelta: 'hi' },
    });
    expect(value).toBe('hi');
    client.close();
  });

  it('times out stalled requests and reconnects when supported', async () => {
    const fake = fakeTransport();
    let reconnects = 0;
    let closeHandler: (() => void) | undefined;
    const transport: RpcTransport = {
      ...fake.transport,
      onClose: (handler) => {
        closeHandler = handler;
        return () => {
          closeHandler = undefined;
        };
      },
      reconnect: () => {
        reconnects++;
        return Promise.resolve();
      },
    };
    const client = createRpcFerryClient(transport, { timeoutMs: 15, reconnectAttempts: 1 });
    const hello = fake.requests[0] as { id: number };
    fake.receive({
      jsonrpc: '2.0',
      id: hello.id,
      result: { protocol: 'ferry/1', capabilities: [], realDomains: [], implementedMethods: [] },
    });
    await client.hello;
    await expect(client.system.info()).rejects.toMatchObject({ kind: 'timeout' });
    closeHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reconnects).toBe(1);
    client.close();
  });

  it('routes requested domains to RPC and leaves the rest mocked', async () => {
    const mock = createMockFerryClient({ behavior: 'test' });
    const fake = fakeTransport();
    const rpc = createRpcFerryClient(fake.transport);
    const hello = fake.requests[0] as { id: number };
    fake.receive({
      jsonrpc: '2.0',
      id: hello.id,
      result: {
        protocol: 'ferry/1',
        capabilities: [],
        realDomains: ['providers'],
        implementedMethods: ['providers.list'],
      },
    });
    await rpc.hello;
    const hybrid = createHybridClient(mock, rpc, []);
    expect((await hybrid.providers.list()).length).toBeGreaterThan(0);
    hybrid.setRealDomains(['providers']);
    const remote = hybrid.providers.list();
    expect(fake.requests.at(-1)).toMatchObject({ method: 'providers.list' });
    fake.receive({ jsonrpc: '2.0', id: (fake.requests.at(-1) as { id: number }).id, result: [] });
    expect(await remote).toEqual([]);
    expect((await hybrid.workspaces.list()).length).toBeGreaterThan(0);
    hybrid.setRealDomains([]);
    expect(hybrid.getRealDomains()).toEqual([]);
    rpc.close();
  });
});
