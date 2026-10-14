import {
  CliConnectionKindSchema,
  CliConnectionSettingsPatchSchema,
  ModelRefSchema,
} from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { getCliConnectionService } from '../cli-connections.js';

export function register(host: CoreHost, services: FerryServices): void {
  const service = getCliConnectionService(services, (method, payload) => {
    host.emit(method, payload);
  });
  host.registerDomain('cliConnections', {
    list: () => service.list(),
    refresh: (id?: unknown) => service.refresh(CliConnectionKindSchema.optional().parse(id)),
    verify: (id: unknown, modelRef?: unknown) => {
      service.verify(
        CliConnectionKindSchema.parse(id),
        modelRef === undefined ? undefined : ModelRefSchema.parse(modelRef),
      );
    },
    update: (id: unknown, patch: unknown) =>
      service.update(
        CliConnectionKindSchema.parse(id),
        CliConnectionSettingsPatchSchema.parse(patch),
      ),
  });
}
