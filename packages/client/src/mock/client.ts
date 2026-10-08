import type { GatewayRequestRecord } from '@ferry/shared';
import type { FerryClient } from '../ferry-client.js';
import type { MockState, MockStore } from './types.js';
import { createMockStore } from './store.js';
import type { MockOptions } from './store.js';
import { createWorkspacesDomain } from './domains/workspaces.js';
import { createSessionsDomain } from './domains/sessions.js';
import { createApprovalsDomain } from './domains/approvals.js';
import { createCheckpointsDomain } from './domains/checkpoints.js';
import { createProvidersDomain } from './domains/providers.js';
import { createOAuthDomain } from './domains/oauth.js';
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
  /** Simulate a Gateway request reaching the log (web preview and tests). */
  __gatewayRequest(record: GatewayRequestRecord): void;
};

export function createMockFerryClient(options: MockOptions = {}): MockFerryClient {
  const runtime = createMockStore(options);
  const { deps } = runtime;
  let gatewaySettings = { enabled: false, port: 11435, allowLan: false };
  const gatewayKeys: {
    id: string;
    name: string;
    profile: string;
    allowedModels: string[];
    rateLimit: number | null;
    tokenLimitPerMinute: number | null;
    tokenLimitPerDay: number | null;
    concurrencyLimit: number | null;
    compressToolResults: boolean;
    terseSystemPrompt: boolean;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    usage: {
      requests: number;
      successfulRequests: number;
      inputTokens: number;
      outputTokens: number;
    };
  }[] = [];
  const gatewayRequests: GatewayRequestRecord[] = [];
  const client: FerryClient = {
    cloud: {
      status: () =>
        Promise.resolve({
          storageMode: 'local',
          configured: false,
          ownerEmail: null,
          message: null,
          auth: { signedIn: false, email: null, userId: null, isOwner: false },
          sync: { pending: 0, failed: 0, lastError: null, lastFlush: null },
        }),
      signIn: () => Promise.reject(new Error('Cloud sign-in is unavailable in mock mode.')),
      signOut: () => Promise.resolve(),
      setStorageMode: ({ mode }) => Promise.resolve({ mode, restartRequired: true }),
      syncNow: () => Promise.resolve(),
      setCaptureContent: ({ value }) => Promise.resolve(value ?? false),
      migrateLocalKeys: () => Promise.resolve({ migrated: 0, missing: 0, failed: 0 }),
    },
    gateway: {
      keySecret: (id) =>
        gatewayKeys.some((key) => key.id === id && !key.revokedAt)
          ? Promise.resolve('ferry-gw-mock-once')
          : Promise.reject(new Error('Unknown or revoked Gateway key')),
      settings: () =>
        Promise.resolve({
          ...gatewaySettings,
          status: {
            running: gatewaySettings.enabled,
            port: gatewaySettings.enabled ? gatewaySettings.port : null,
            host: gatewaySettings.enabled ? '127.0.0.1' : null,
            url: gatewaySettings.enabled
              ? `http://127.0.0.1:${String(gatewaySettings.port)}`
              : null,
          },
        }),
      setSettings: async (input) => {
        gatewaySettings = input;
        return client.gateway.settings();
      },
      listKeys: () =>
        Promise.resolve(
          gatewayKeys.map((key) => ({ ...key, allowedModels: [...key.allowedModels] })),
        ),
      createKey: (input) => {
        const key = {
          id: crypto.randomUUID(),
          name: input.name,
          profile: input.profile,
          allowedModels: [],
          rateLimit: null,
          tokenLimitPerMinute: null,
          tokenLimitPerDay: null,
          concurrencyLimit: null,
          compressToolResults: true,
          terseSystemPrompt: false,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
          usage: { requests: 0, successfulRequests: 0, inputTokens: 0, outputTokens: 0 },
        };
        gatewayKeys.push(key);
        return Promise.resolve({
          key: { id: key.id, name: key.name, profile: key.profile },
          secret: 'ferry-gw-mock-once',
        });
      },
      updateKey: ({ id, patch }) => {
        const key = gatewayKeys.find((entry) => entry.id === id);
        if (key) Object.assign(key, patch);
        return Promise.resolve(key);
      },
      revokeKey: (id) => {
        const key = gatewayKeys.find((entry) => entry.id === id);
        if (key) key.revokedAt = new Date().toISOString();
        return Promise.resolve(undefined);
      },
      requests: () => Promise.resolve(gatewayRequests.map((record) => ({ ...record }))),
      start: async () => {
        gatewaySettings = { ...gatewaySettings, enabled: true };
        return client.gateway.settings();
      },
      stop: async () => {
        gatewaySettings = { ...gatewaySettings, enabled: false };
        return client.gateway.settings();
      },
    },
    workspaces: createWorkspacesDomain(runtime.store, deps),
    sessions: createSessionsDomain(runtime.store, deps),
    approvals: createApprovalsDomain(runtime.store, deps),
    checkpoints: createCheckpointsDomain(runtime.store, deps),
    providers: createProvidersDomain(runtime.store, deps),
    oauth: createOAuthDomain(runtime.store, deps),
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
    __gatewayRequest: (record: GatewayRequestRecord) => {
      gatewayRequests.unshift(record);
      gatewayRequests.splice(200);
      const key = gatewayKeys.find((entry) => entry.id === record.keyId);
      if (key) {
        key.lastUsedAt = record.at;
        key.usage.requests += 1;
        if (record.status === 'ok') {
          key.usage.successfulRequests += 1;
          key.usage.inputTokens += record.inputTokens;
          key.usage.outputTokens += record.outputTokens;
        }
      }
      deps.emitter.emit('gateway.request', record);
    },
  });
}
