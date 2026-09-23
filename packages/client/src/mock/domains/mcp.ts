import { MockNotFoundError } from '../errors.js';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createMcpDomain(_store: MockStore, deps: MockDeps): FerryClient['mcp'] {
  const { state, before, persist, syncStore } = deps;
  return {
    async list() {
      await before();
      return structuredClone(state.mcps);
    },
    async setEnabled(id, v) {
      await before();
      const x = state.mcps.find((x) => x.id === id);
      if (!x) throw new MockNotFoundError('MCP', id);
      x.status = v ? 'connected' : 'disconnected';
      persist();
      syncStore();
      return structuredClone(x);
    },
  };
}
