import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createMockFerryClient, createPlaybackRunner } from '@ferry/client';
import { createRpcFerryClient } from '@ferry/client';
import type { FerryClient } from '@ferry/client';
import { canonicalizePath } from '@ferry/shared/node-paths';
import { prepareEngineDataDirectory } from './data-directory.js';

export {
  desktopEngineDataDirectory,
  prepareEngineDataDirectory,
  resolveEngineDataDirectory,
} from './data-directory.js';

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
  const dataDir = canonicalizePath(
    options.dataDir ?? process.env.FERRY_DATA_DIR ?? join(homedir(), '.ferry'),
  );
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
  const dataDir = canonicalizePath(await prepareEngineDataDirectory(options.dataDir));
  const core = await import('@ferry/core');
  const { createCoreHost, createMemoryTransportPair } = core;
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  let host: Awaited<ReturnType<typeof createCoreHost>>;
  try {
    host = await createCoreHost({ dataDir, transport: coreTransport });
  } catch (error) {
    if (error instanceof core.CoreLockError)
      throw new Error(
        `A Ferry core already owns ${dataDir}. Close Ferry or stop the other CLI engine process, or pass --data-dir to use another engine directory.`,
        { cause: error },
      );
    throw error;
  }
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
