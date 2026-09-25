import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { register as registerCheckpoints } from './checkpoints.js';
import { register as registerSessions } from './sessions.js';
import { register as registerProfiles } from './profiles.js';
import { register as registerSkills } from './skills.js';
import { register as registerMcp } from './mcp.js';
import { register as registerOptimizer } from './optimizer.js';
import { register as registerDelegation } from './delegation.js';
import { register as registerSettings } from './settings.js';
import { register as registerWorkspaces } from './workspaces.js';

export type DomainRegistrar = (host: CoreHost, services: FerryServices) => void;
export const domainRegistrars: DomainRegistrar[] = [
  registerSettings,
  registerWorkspaces,
  registerCheckpoints,
  registerSessions,
  registerProfiles,
  registerSkills,
  registerMcp,
  registerOptimizer,
  registerDelegation,
];
