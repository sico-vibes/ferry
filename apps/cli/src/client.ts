import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createMockFerryClient, createPlaybackRunner } from '@ferry/client';
import { createRpcFerryClient, RpcError, type RpcTransport } from '@ferry/client';
import type { FerryClient } from '@ferry/client';
import { canonicalizePath } from '@ferry/shared/node-paths';
import { prepareEngineDataDirectory, resolveEngineDataDirectory } from './data-directory.js';

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

export type LocalCoreSelection =
  { kind: 'start' } | { kind: 'connect'; pid: number } | { kind: 'unavailable'; pid: number };

export function selectLocalCore(
  lock: unknown,
  endpointAvailable: boolean,
  isProcessAlive: (pid: number) => boolean,
): LocalCoreSelection {
  const pid = readLockPid(lock);
  if (pid === undefined || !isProcessAlive(pid)) return { kind: 'start' };
  return endpointAvailable ? { kind: 'connect', pid } : { kind: 'unavailable', pid };
}

export async function inspectLocalCore(dataDirectory?: string): Promise<LocalCoreSelection> {
  const core = await import('@ferry/core');
  const dataDir = canonicalizePath(resolveEngineDataDirectory(dataDirectory));
  return await selectExistingCore(dataDir, core);
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
  const core = await import('@ferry/core');
  const dataDir = canonicalizePath(resolveEngineDataDirectory(options.dataDir));
  const selection = await selectExistingCore(dataDir, core);
  if (selection.kind === 'connect') {
    await prepareEngineDataDirectory(options.dataDir);
    return await connectToExistingCore(dataDir, selection.pid, core);
  }
  if (selection.kind === 'unavailable') throw unavailableCoreError(dataDir, selection.pid);

  const preparedDataDir = canonicalizePath(await prepareEngineDataDirectory(options.dataDir));
  const preparedSelection = await selectExistingCore(preparedDataDir, core);
  if (preparedSelection.kind === 'connect')
    return await connectToExistingCore(preparedDataDir, preparedSelection.pid, core);
  if (preparedSelection.kind === 'unavailable')
    throw unavailableCoreError(preparedDataDir, preparedSelection.pid);

  const [coreTransport, clientTransport] = core.createMemoryTransportPair();
  let host: Awaited<ReturnType<typeof core.createCoreHost>>;
  try {
    host = await core.createCoreHost({
      dataDir: preparedDataDir,
      transport: coreTransport,
      localControl: true,
    });
  } catch (error) {
    if (error instanceof core.CoreLockError) {
      const racedSelection = await selectExistingCore(preparedDataDir, core);
      if (racedSelection.kind === 'connect')
        return await connectToExistingCore(preparedDataDir, racedSelection.pid, core);
      if (racedSelection.kind === 'unavailable')
        throw unavailableCoreError(preparedDataDir, racedSelection.pid, error);
    }
    throw error;
  }
  const rpc = createRpcFerryClient(clientTransport);
  try {
    await rpc.hello;
  } catch (error) {
    rpc.close();
    await host.stop();
    throw error;
  }
  return managedClient(rpc, () => host.stop());
}

type CoreApi = typeof import('@ferry/core');

async function selectExistingCore(dataDir: string, core: CoreApi): Promise<LocalCoreSelection> {
  const lock = await core.readLockInfo(dataDir);
  const endpoint = await core.hasLocalControlEndpoint(dataDir);
  return selectLocalCore(lock, endpoint, isProcessAlive);
}

async function connectToExistingCore(
  dataDir: string,
  pid: number,
  core: CoreApi,
): Promise<FerryClient & { dispose?: () => Promise<void> }> {
  try {
    const transport = await core.connectLocalControl(dataDir);
    const rpcTransport: RpcTransport = {
      send(message) {
        transport.send(message);
      },
      subscribe: (handler) => transport.subscribe(handler),
      onClose: (handler) =>
        transport.onClose((reason) => {
          handler(reason ? new RpcError(reason.message, -32000, 'unavailable') : undefined);
        }),
      reconnect: () => transport.reconnect(),
      close: () => transport.close?.(),
    };
    const rpc = createRpcFerryClient(rpcTransport);
    try {
      await rpc.hello;
    } catch (error) {
      rpc.close();
      throw error;
    }
    return managedClient(rpc);
  } catch (error) {
    throw unavailableCoreError(dataDir, pid, error);
  }
}

function managedClient(
  rpc: ReturnType<typeof createRpcFerryClient>,
  stopHost?: () => Promise<void>,
): FerryClient & { dispose?: () => Promise<void> } {
  return new Proxy(rpc, {
    get(target, property, receiver) {
      if (property === 'close')
        return () => {
          target.close();
          if (stopHost) void stopHost();
        };
      if (property === 'dispose')
        return async () => {
          target.close();
          await stopHost?.();
        };
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function unavailableCoreError(dataDir: string, pid: number, cause?: unknown): Error {
  const canonicalDataDir = realpathSync.native(dataDir);
  return new Error(
    `Ferry core PID ${String(pid)} owns ${canonicalDataDir}, but its local control channel is unavailable. Update or restart Ferry, or pass --data-dir to use another engine directory.`,
    cause === undefined ? undefined : { cause },
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

function readLockPid(lock: unknown): number | undefined {
  if (
    typeof lock !== 'object' ||
    lock === null ||
    !('pid' in lock) ||
    typeof lock.pid !== 'number' ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 1
  )
    return undefined;
  return lock.pid;
}
