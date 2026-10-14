import {
  CliConnectionKindSchema,
  CliConnectionSettingsPatchSchema,
  ModelRefSchema,
} from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { getCliConnectionService } from '../cli-connections.js';
import { getCliBroker } from '../cli-broker.js';

export function register(host: CoreHost, services: FerryServices): void {
  const emit = (method: string, payload: unknown) => {
    host.emit(method, payload);
  };
  const service = getCliConnectionService(services, emit);
  const broker = getCliBroker(services, emit);
  host.registerDomain('cliConnections', {
    list: () => {
      // The broker revalidates receipts against changes discovery cannot see, then returns the cache.
      broker.connections();
      return service.list();
    },
    refresh: (id?: unknown) => service.refresh(CliConnectionKindSchema.optional().parse(id)),
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
