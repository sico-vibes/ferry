import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { register as registerCheckpoints } from './checkpoints.js';
import { register as registerModels } from './models.js';
import { register as registerProviders } from './providers.js';
import { register as registerQuota } from './quota.js';
import { register as registerSettings } from './settings.js';
import { register as registerWorkspaces } from './workspaces.js';

export type DomainRegistrar = (host: CoreHost, services: FerryServices) => void;
export const domainRegistrars: DomainRegistrar[] = [
  registerSettings,
  registerWorkspaces,
  registerCheckpoints,
  registerProviders,
  registerModels,
  registerQuota,
];
