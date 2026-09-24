import type { StorageAdapter } from '../storage.js';
import { localStorageAdapter } from '../storage.js';
import { createMockFerryClient } from '../client.js';
import type { MockFerryClient } from '../client.js';
import { createPlaybackRunner } from './engine.js';

export function createDemoFerryClient(
  options: { storage?: StorageAdapter; speed?: number; latencyMs?: number } = {},
): MockFerryClient {
  return createMockFerryClient({
    storage: options.storage ?? localStorageAdapter(),
    behavior: 'live',
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
    scenarioRunner: createPlaybackRunner({
      ...(options.speed === undefined ? {} : { speed: options.speed }),
    }),
  });
}
