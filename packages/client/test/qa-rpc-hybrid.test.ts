import { describe, expect, it } from 'vitest';
import { createMockFerryClient } from '../src/mock/client.js';
import {
  RpcError,
  createHybridClient,
  createRpcFerryClient,
  type RpcTransport,
} from '../src/rpc.js';

interface FakeRpc {
  transport: RpcTransport;
  requests: { id: number; method: string; params: unknown[] }[];
  receive(message: unknown): void;
}

function fakeRpc(): FakeRpc {
  let listener: ((message: unknown) => void) | undefined;
  const requests: { id: number; method: string; params: unknown[] }[] = [];
  return {
    transport: {
      send: (message) =>
        requests.push(message as { id: number; method: string; params: unknown[] }),
      subscribe: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    },
    requests,
    receive: (message) => listener?.(message),
  };
}

const HELLO = {
  protocol: 'ferry/1',
  capabilities: [],
  realDomains: [],
  implementedMethods: [],
} as const;

async function connectRpc(rpc: FakeRpc, result: unknown = HELLO) {
  const client = createRpcFerryClient(rpc.transport, { timeoutMs: 2000 });
  const hello = rpc.requests[0];
  if (!hello) throw new Error('hello was not sent');
  rpc.receive({ jsonrpc: '2.0', id: hello.id, result });
  await client.hello;
  return client;
}

describe('QA RpcFerryClient request correlation', () => {
  it('resolves concurrent requests by id even when responses arrive out of order', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc);
    try {
      const first = client.providers.list();
      const second = client.workspaces.list();
      const callFirst = rpc.requests[1];
      const callSecond = rpc.requests[2];
      if (!callFirst || !callSecond) throw new Error('requests missing');
      rpc.receive({ jsonrpc: '2.0', id: callSecond.id, result: [{ marker: 'second' }] });
      rpc.receive({ jsonrpc: '2.0', id: callFirst.id, result: [{ marker: 'first' }] });
      expect(await first).toEqual([{ marker: 'first' }]);
      expect(await second).toEqual([{ marker: 'second' }]);
    } finally {
      client.close();
    }
  });

  it('ignores responses for unknown or duplicate ids', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc);
    try {
      const pending = client.system.info();
      const call = rpc.requests[1];
      if (!call) throw new Error('request missing');
      rpc.receive({ jsonrpc: '2.0', id: 999_999, result: { ignored: true } });
      rpc.receive({ jsonrpc: '2.0', id: call.id, result: { version: '1', mock: false } });
      rpc.receive({ jsonrpc: '2.0', id: call.id, result: { version: '2', mock: true } });
      await expect(pending).resolves.toMatchObject({ version: '1' });
    } finally {
      client.close();
    }
  });

  it('surfaces a typed error payload and defaults an untyped failure to internal', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc);
    try {
      const missing = client.workspaces.open('x');
      const callMissing = rpc.requests[1];
      if (!callMissing) throw new Error('request missing');
      rpc.receive({
        jsonrpc: '2.0',
        id: callMissing.id,
        error: {
          code: -32044,
          message: 'nope',
          data: { kind: 'not_found', details: { id: 'x' } },
        },
      });
      await expect(missing).rejects.toMatchObject({
        code: -32044,
        kind: 'not_found',
        details: { id: 'x' },
      });

      const plain = client.system.info();
      const callPlain = rpc.requests[2];
      if (!callPlain) throw new Error('request missing');
      rpc.receive({ jsonrpc: '2.0', id: callPlain.id, error: { code: -32603, message: 'boom' } });
      await expect(plain).rejects.toMatchObject({ code: -32603, kind: 'internal' });
    } finally {
      client.close();
    }
  });

  it('rejects immediately after close instead of hanging', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc);
    client.close();
    await expect(client.system.info()).rejects.toMatchObject({
      kind: 'unavailable',
      code: -32000,
    });
  });

  it('delivers each notification once and skips schema-invalid payloads', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc);
    try {
      const mock = createMockFerryClient({ behavior: 'test' });
      const settings = await mock.settings.get();
      let count = 0;
      client.on('settings.updated', () => count++);
      rpc.receive({ jsonrpc: '2.0', method: 'settings.updated', params: settings });
      rpc.receive({ jsonrpc: '2.0', method: 'settings.updated', params: { theme: 'neon' } });
      rpc.receive({ jsonrpc: '2.0', method: 'settings.updated', params: settings });
      expect(count).toBe(2);
    } finally {
      client.close();
    }
  });

  it('records implemented methods from hello', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc, {
      ...HELLO,
      realDomains: ['providers'],
      implementedMethods: ['providers.list', 'providers.probe'],
    });
    try {
      expect([...client.implementedMethods]).toEqual(['providers.list', 'providers.probe']);
    } finally {
      client.close();
    }
  });
});

describe('QA HybridClient routing', () => {
  it('routes domains by flag and flips at runtime without reconnecting', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc, {
      ...HELLO,
      realDomains: ['providers'],
      implementedMethods: ['providers.list'],
    });
    const mock = createMockFerryClient({ behavior: 'test' });
    const hybrid = createHybridClient(mock, client, []);
    try {
      const before = rpc.requests.length;
      expect((await hybrid.providers.list()).length).toBeGreaterThan(0);
      expect(rpc.requests.length).toBe(before);

      hybrid.setRealDomains(['providers']);
      expect(hybrid.getRealDomains()).toEqual(['providers']);
      const remote = hybrid.providers.list();
      const call = rpc.requests.at(-1);
      if (!call) throw new Error('request missing');
      expect(call.method).toBe('providers.list');
      rpc.receive({ jsonrpc: '2.0', id: call.id, result: [] });
      expect(await remote).toEqual([]);

      expect((await hybrid.workspaces.list()).length).toBeGreaterThan(0);
      hybrid.setRealDomains([]);
      expect(hybrid.getRealDomains()).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('rejects with the typed domain error when the real domain fails (no hang)', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc, {
      ...HELLO,
      realDomains: ['providers'],
      implementedMethods: ['providers.probe'],
    });
    const mock = createMockFerryClient({ behavior: 'test' });
    const hybrid = createHybridClient(mock, client, ['providers']);
    try {
      const pending = hybrid.providers.probe('openrouter' as never);
      const call = rpc.requests.at(-1);
      if (!call) throw new Error('request missing');
      rpc.receive({
        jsonrpc: '2.0',
        id: call.id,
        error: { code: -32050, message: 'provider unavailable', data: { kind: 'unavailable' } },
      });
      await expect(pending).rejects.toBeInstanceOf(RpcError);
      await expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
    } finally {
      client.close();
    }
  });

  it('flips real domains when settings.update returns developer.realDomains', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc, {
      ...HELLO,
      realDomains: ['settings'],
      implementedMethods: ['settings.update'],
    });
    const mock = createMockFerryClient({ behavior: 'test' });
    const hybrid = createHybridClient(mock, client, ['settings']);
    try {
      const pending = hybrid.settings.update({
        theme: 'light',
        developer: {
          showReferenceOverlay: false,
          mockLatency: false,
          injectErrors: false,
          realDomains: ['workspaces'],
        },
      } as never);
      const call = rpc.requests.at(-1);
      if (!call) throw new Error('request missing');
      const settings = await mock.settings.get();
      rpc.receive({
        jsonrpc: '2.0',
        id: call.id,
        result: { ...settings, developer: { ...settings.developer, realDomains: ['workspaces'] } },
      });
      await pending;
      expect(hybrid.getRealDomains()).toEqual(['workspaces']);
    } finally {
      client.close();
    }
  });

  it('routes event subscriptions to the source owning the event domain', async () => {
    const rpc = fakeRpc();
    const client = await connectRpc(rpc, {
      ...HELLO,
      realDomains: ['settings'],
      implementedMethods: [],
    });
    const mock = createMockFerryClient({ behavior: 'test' });
    const settings = await mock.settings.get();
    const hybrid = createHybridClient(mock, client, ['settings']);
    try {
      let remoteEvents = 0;
      let mockEvents = 0;
      const offRemote = hybrid.on('settings.updated', () => remoteEvents++);
      const offMock = hybrid.on('workspace.updated', () => mockEvents++);
      rpc.receive({ jsonrpc: '2.0', method: 'settings.updated', params: settings });
      expect(remoteEvents).toBe(1);
      expect(mockEvents).toBe(0);
      offRemote();
      offMock();
      rpc.receive({ jsonrpc: '2.0', method: 'settings.updated', params: settings });
      expect(remoteEvents).toBe(1);
    } finally {
      client.close();
    }
  });
});
