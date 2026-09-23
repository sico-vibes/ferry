import type { FerryEvents } from '../events.js';

export class TypedEmitter {
  private listeners = new Map<keyof FerryEvents, Set<(payload: never) => void>>();
  on<E extends keyof FerryEvents>(
    event: E,
    handler: (payload: FerryEvents[E]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
  emit<E extends keyof FerryEvents>(event: E, payload: FerryEvents[E]): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      try {
        handler(payload as never);
      } catch (error) {
        console.error(`Ferry event handler failed (${event})`, error);
      }
    }
  }
}
