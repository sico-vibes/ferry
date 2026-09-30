import { describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { createMockFerryClient } from '../src/index.js';
import {
  createHybridClient,
  createMessagePortTransport,
  createRpcFerryClient,
  RpcError,
  type RpcTransport,
} from '../src/rpc.js';
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
  it('can be returned from an async bootstrap without thenable assimilation', async () => {
    const mock = createMockFerryClient({ behavior: 'test' });
    const hybrid = createHybridClient(mock, mock, []);
    await expect(Promise.resolve(hybrid)).resolves.toBe(hybrid);
  });

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

  it('rejects in-flight requests with core_restarted and reconnects when supported', async () => {
    const fake = fakeTransport();
    let reconnects = 0;
    let closeHandler: ((reason?: RpcError) => void) | undefined;
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
    const client = createRpcFerryClient(transport, { timeoutMs: 1_000, reconnectAttempts: 1 });
    const hello = fake.requests[0] as { id: number };
    fake.receive({
      jsonrpc: '2.0',
      id: hello.id,
      result: { protocol: 'ferry/1', capabilities: [], realDomains: [], implementedMethods: [] },
    });
    await client.hello;
    const pending = client.system.info();
    closeHandler?.(
      new RpcError('Core restarted while the request was pending', -32002, 'core_restarted'),
    );
    await expect(pending).rejects.toMatchObject({ kind: 'core_restarted' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reconnects).toBe(1);
    client.close();
  });

  it('attaches the replacement port before notifying consumers that reconnect completed', async () => {
    const initial = new MessageChannel();
    const replacement = new MessageChannel();
    const order: string[] = [];
    const received: unknown[] = [];
    const sent: unknown[] = [];
    const diagnostics: import('../src/rpc.js').MessagePortTransportDiagnostic[] = [];
    let restart: (() => void) | undefined;
    let restartReason: RpcError | undefined;
    const deferred: { attached?: () => void; reply?: (message: unknown) => void } = {};
    const attached = new Promise<void>((resolve) => {
      deferred.attached = resolve;
    });
    const reply = new Promise<unknown>((resolve) => {
      deferred.reply = resolve;
    });
    const transport = createMessagePortTransport(
      { port: initial.port1, portId: 'port-old' },
      {
        reconnect: () => Promise.resolve({ port: replacement.port1, portId: 'port-new' }),
        onRestarting: (handler) => {
          restart = handler;
          return () => {
            restart = undefined;
          };
        },
        onReconnected: () => {
          order.push('reconnected');
          deferred.attached?.();
        },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );
    transport.subscribe((message) => {
      received.push(message);
      deferred.reply?.(message);
    });
    transport.onClose?.((reason) => {
      restartReason = reason;
    });
    replacement.port2.addEventListener('message', (event) => {
      sent.push(event.data);
      replacement.port2.postMessage({ jsonrpc: '2.0', id: 17, result: { core: 'new' } });
    });
    replacement.port2.start();
    transport.onClose?.(() => {
      void transport.reconnect?.();
    });

    restart?.();
    expect(restartReason).toMatchObject({ kind: 'core_restarted' });
    transport.send({ jsonrpc: '2.0', id: 17, method: 'sessions.get', params: ['session-1'] });
    await attached;
    order.push('returned');
    await expect(reply).resolves.toEqual({ jsonrpc: '2.0', id: 17, result: { core: 'new' } });

    expect(order).toEqual(['reconnected', 'returned']);
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 17, method: 'sessions.get', params: ['session-1'] },
    ]);
    expect(received).toEqual([{ jsonrpc: '2.0', id: 17, result: { core: 'new' } }]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'attached', generation: 1, portId: 'port-old' }),
        expect.objectContaining({ event: 'restarting', generation: 1, portId: 'port-old' }),
        expect.objectContaining({
          event: 'queued',
          generation: 1,
          portId: 'port-old',
          requestId: 17,
          method: 'sessions.get',
        }),
        expect.objectContaining({ event: 'attached', generation: 2, portId: 'port-new' }),
        expect.objectContaining({ event: 'sent', generation: 2, portId: 'port-new' }),
        expect.objectContaining({ event: 'received', generation: 2, portId: 'port-new' }),
      ]),
    );
    transport.close?.();
    initial.port2.close();
    replacement.port2.close();
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
