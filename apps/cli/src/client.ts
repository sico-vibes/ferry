import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createMockFerryClient, createPlaybackRunner } from '@ferry/client';
import { createRpcFerryClient } from '@ferry/client';
import type { FerryClient } from '@ferry/client';

interface StorageAdapter {
  load(): unknown;
  save(data: unknown): void;
}

export interface ClientOptions {
  engine?: 'mock' | 'local';
  dataDir?: string;
}

function fileStorage(path: string): StorageAdapter {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
    save(data) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify(data), 'utf8');
    },
  };
}

export function createClient(options: ClientOptions = {}): FerryClient {
  if ((options.engine ?? 'mock') === 'local')
    throw new Error('The local engine is asynchronous; use createClientAsync instead');
  const dataDir = options.dataDir ?? join(homedir(), '.ferry');
  return createMockFerryClient({
    storage: fileStorage(join(dataDir, 'cli-state.json')),
    behavior: 'live',
    scenarioRunner: createPlaybackRunner(),
  });
}

export async function createClientAsync(
  options: ClientOptions = {},
): Promise<FerryClient & { dispose?: () => Promise<void> }> {
  if ((options.engine ?? 'mock') === 'mock') return createClient(options);
  const dataDir = options.dataDir ?? join(homedir(), '.ferry');
  const { createCoreHost, createMemoryTransportPair } = await import('@ferry/core');
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({ dataDir, transport: coreTransport });
  const rpc = createRpcFerryClient(clientTransport);
  await rpc.hello;
  return new Proxy(rpc, {
    get(target, property, receiver) {
      if (property === 'close')
        return () => {
          target.close();
          void host.stop();
        };
      if (property === 'dispose')
        return async () => {
          target.close();
          await host.stop();
        };
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}
