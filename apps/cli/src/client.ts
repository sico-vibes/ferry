import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createMockFerryClient, createPlaybackRunner } from '@ferry/client';
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
  const dataDir = options.dataDir ?? join(homedir(), '.ferry');
  if ((options.engine ?? 'mock') === 'local') {
    // RPC seam: replace this mock with RpcFerryClient when `ferry serve` lands.
  }
  return createMockFerryClient({
    storage: fileStorage(join(dataDir, 'cli-state.json')),
    behavior: 'live',
    scenarioRunner: createPlaybackRunner(),
  });
}
