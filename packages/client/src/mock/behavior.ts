import type { Clock } from './clock.js';
import type { ReturnTypeRng } from './types.js';

export interface MockBehavior {
  latency: boolean;
  injectErrors: boolean;
}
export class MockInjectedError extends Error {
  constructor() {
    super('Injected mock failure');
    this.name = 'MockInjectedError';
  }
}
export function behaviorDelay(clock: Clock, rng: ReturnTypeRng, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}
