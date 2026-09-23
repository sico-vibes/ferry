import type { FerryClient } from '../ferry-client.js';
import type { MockState, MockStore } from './types.js';
import { createMockStore } from './store.js';
import type { MockOptions } from './store.js';
import { createWorkspacesDomain } from './domains/workspaces.js';
import { createSessionsDomain } from './domains/sessions.js';
import { createApprovalsDomain } from './domains/approvals.js';
import { createCheckpointsDomain } from './domains/checkpoints.js';
import { createProvidersDomain } from './domains/providers.js';
import { createQuotaDomain } from './domains/quota.js';
import { createModelsDomain } from './domains/models.js';
import { createProfilesDomain } from './domains/profiles.js';
import { createSettingsDomain } from './domains/settings.js';
import { createOptimizerDomain } from './domains/optimizer.js';
import { createDelegationDomain } from './domains/delegation.js';
import { createSkillsDomain } from './domains/skills.js';
import { createMcpDomain } from './domains/mcp.js';
import { createSystemDomain } from './domains/system.js';
import { MockNotFoundError } from './errors.js';

export { MockNotFoundError };
export type { MockOptions };
export type MockFerryClient = FerryClient & {
  __reset(): void;
  __state(): Readonly<MockState>;
  __store(): Readonly<MockStore>;
};

export function createMockFerryClient(options: MockOptions = {}): MockFerryClient {
  const runtime = createMockStore(options);
  const { deps } = runtime;
  const client: FerryClient = {
    workspaces: createWorkspacesDomain(runtime.store, deps),
    sessions: createSessionsDomain(runtime.store, deps),
    approvals: createApprovalsDomain(runtime.store, deps),
    checkpoints: createCheckpointsDomain(runtime.store, deps),
    providers: createProvidersDomain(runtime.store, deps),
    quota: createQuotaDomain(runtime.store, deps),
    models: createModelsDomain(runtime.store, deps),
    profiles: createProfilesDomain(runtime.store, deps),
    settings: createSettingsDomain(runtime.store, deps),
    optimizer: createOptimizerDomain(runtime.store, deps),
    delegation: createDelegationDomain(runtime.store, deps),
    skills: createSkillsDomain(runtime.store, deps),
    mcp: createMcpDomain(runtime.store, deps),
    system: createSystemDomain(runtime.store, deps),
    on: (event, handler) => deps.emitter.on(event, handler),
  };
  return Object.assign(client, {
    __reset: runtime.reset,
    __state: () => runtime.state,
    __store: () => runtime.store,
  });
}
