import {
  CliConnectionKindSchema,
  CliConnectionSettingsPatchSchema,
  ModelRefSchema,
} from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { getCliConnectionService, registerCliEmit } from '../cli-connections.js';
import { getCliBroker } from '../cli-broker.js';

export function register(host: CoreHost, services: FerryServices): void {
  const emit = (method: string, payload: unknown) => {
    host.emit(method, payload);
  };
  // This domain is registered after the Gateway controller (which constructs the broker with an inert
  // emit). Registering here upgrades the shared target to the real host emit so discovery, verification
  // and live usage updates reach RPC subscribers instead of being silently dropped.
  registerCliEmit(services, emit);
  const service = getCliConnectionService(services, emit);
  const broker = getCliBroker(services, emit);
  host.registerDomain('cliConnections', {
    list: () => {
      // Keep background discovery scheduling (via the service) but return the broker-revalidated
      // cache, so a receipt bound to changed/removed model capabilities is never reported verified.
      service.list();
      return broker.connections();
    },
    async refresh(id?: unknown) {
      const kind = CliConnectionKindSchema.optional().parse(id);
      // Probe only the requested kind (or all when omitted), but always return the FULL revalidated
      // snapshot. Callers cache the whole list (e.g. `setQueryData(await refresh(kind))`), so filtering
      // to one connection would drop the other kinds and their opt-ins/receipts.
      await service.refresh(kind);
      return broker.connections();
    },
    verify: (id: unknown, modelRef?: unknown) =>
      broker.verify(
        CliConnectionKindSchema.parse(id),
        modelRef === undefined ? undefined : ModelRefSchema.parse(modelRef),
      ),
    update: (id: unknown, patch: unknown) =>
      service.update(
        CliConnectionKindSchema.parse(id),
        CliConnectionSettingsPatchSchema.parse(patch),
      ),
  });
}
