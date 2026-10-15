import type { CliConnectionKind, CliConnectionSettings } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';
import {
  buildMockCliConnection,
  verifyMockCliConnection,
  MOCK_CLI_KINDS,
} from '../cli-inventory.js';

export function createCliConnectionsDomain(
  _store: MockStore,
  deps: MockDeps,
): FerryClient['cliConnections'] {
  const { before, emit, state } = deps;
  const kinds = MOCK_CLI_KINDS;
  // Scripted verification receipts live on the store so the model/provider inventory reacts too.
  const build = (id: CliConnectionKind) => buildMockCliConnection(state, id);
  return {
    async list() {
      await before();
      return kinds.map(build);
    },
    async refresh(id) {
      await before();
      const selected = id ? [id] : kinds;
      const connections = selected.map(build);
      for (const connection of connections) emit('cliConnections.updated', connection);
      return kinds.map(build);
    },
    async verify(id, modelRef) {
      await before();
      // One shared verification path: the receipt is recorded in the same per-model store the Zen
      // facade reads, bound to the current credential source.
      const result = verifyMockCliConnection(state, id, modelRef);
      emit('cliConnections.updated', build(id));
      return result;
    },
    async update(id, patch) {
      await before();
      const current: Partial<CliConnectionSettings> = state.settings.cliConnections[id] ?? {};
      const defaultOptions = patch.defaultOptions;
      // An explicit `null` clears the stored override; an absent field preserves it.
      const effort =
        defaultOptions && 'effort' in defaultOptions
          ? (defaultOptions.effort ?? null)
          : (current.defaultOptions?.effort ?? null);
      state.settings.cliConnections[id] = {
        native: patch.surfaces?.native ?? current.native ?? false,
        gateway: patch.surfaces?.gateway ?? current.gateway ?? false,
        credentialMode: patch.credentialMode ?? current.credentialMode ?? 'installed',
        credentialProvider:
          'credentialProvider' in patch
            ? (patch.credentialProvider ?? null)
            : (current.credentialProvider ?? null),
        defaultOptions: {
          effort,
          speed: defaultOptions?.speed ?? current.defaultOptions?.speed ?? 'standard',
        },
        modelDefaults: patch.modelDefaults ?? current.modelDefaults ?? {},
      };
      const connection = build(id);
      emit('cliConnections.updated', connection);
      return connection;
    },
  };
}
