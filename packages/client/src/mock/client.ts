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
import { createCliConnectionsDomain } from './domains/cliConnections.js';
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
    client?: string;
    profile: string;
    allowedModels: string[];
    rateLimit: number | null;
    tokenLimitPerMinute: number | null;
    tokenLimitPerDay: number | null;
    concurrencyLimit: number | null;
    paidBackup: boolean;
    budgetUsd: number | null;
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
      status: async () => {
        await deps.before();
        return {
          storageMode: 'local',
          configured: false,
          ownerEmail: null,
          message: null,
          auth: { signedIn: false, email: null, userId: null, isOwner: false },
          sync: { pending: 0, failed: 0, lastError: null, lastFlush: null },
        };
      },
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
      settings: async () => {
        await deps.before();
        return {
          ...gatewaySettings,
          status: {
            running: gatewaySettings.enabled,
            port: gatewaySettings.enabled ? gatewaySettings.port : null,
            host: gatewaySettings.enabled ? '127.0.0.1' : null,
            url: gatewaySettings.enabled
              ? `http://127.0.0.1:${String(gatewaySettings.port)}`
              : null,
          },
        };
      },
      setSettings: async (input) => {
        gatewaySettings = input;
        return client.gateway.settings();
      },
      listKeys: async () => {
        await deps.before();
        return gatewayKeys.map((key) => ({ ...key, allowedModels: [...key.allowedModels] }));
      },
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
          paidBackup: false,
          budgetUsd: null,
          compressToolResults: false,
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
      requests: async () => {
        await deps.before();
        return gatewayRequests.map((record) => ({ ...record }));
      },
      history: async (input = {}) => {
        await deps.before();
        const days = input.range === '7d' ? 7 : input.range === '30d' ? 30 : 1;
        const query = (input.query ?? '').toLowerCase();
        const records = gatewayRequests.filter(
          (row) =>
            Date.parse(row.at) >= Date.now() - days * 86_400_000 &&
            (!input.keyId || row.keyId === input.keyId) &&
            (!input.status || row.status === input.status) &&
            `${row.keyName} ${row.requestedModel} ${row.modelRef ?? ''} ${row.id}`
              .toLowerCase()
              .includes(query),
        );
        const offset = input.offset ?? 0,
          limit = input.limit ?? 50;
        return {
          records: records.slice(offset, offset + limit),
          total: records.length,
          nextOffset: offset + limit < records.length ? offset + limit : null,
        };
      },
      request: (id) => Promise.resolve(gatewayRequests.find((row) => row.id === id) ?? null),
      activity: () => Promise.resolve({ active: 0, queued: 0 }),
      routing: async (id) => {
        await deps.before();
        const key = gatewayKeys.find((key) => key.id === id && !key.revokedAt);
        const models = runtime.store.models.filter(
          (model) =>
            model.free &&
            runtime.store.providers.some(
              (provider) =>
                provider.id === model.providerId &&
                provider.enabled &&
                ['valid', 'not_applicable'].includes(provider.keyStatus),
            ),
        );
        return {
          profile: key?.profile ?? 'auto-free',
          summary:
            'Auto balances suitability, reliability, quota and response time. This web preview uses fixture data.',
          eligible: models.slice(0, 10).map((model, index) => ({
            modelRef: model.ref,
            providerId: model.providerId,
            order: index + 1,
            quotaHeadroom: null,
          })),
          excluded: [],
          lastDecision: gatewayRequests.find((row) => !id || row.keyId === id) ?? null,
        };
      },
      usage: async (input = {}) => {
        const page = await client.gateway.history({ range: input.range ?? '24h', limit: 100 });
        const groups = new Map<string, import('@ferry/shared').GatewayUsageGroup>();
        for (const row of page.records) {
          const name =
            (input.groupBy === 'provider'
              ? row.providerId
              : input.groupBy === 'model'
                ? row.modelRef
                : row.keyId) ?? 'Unserved';
          const group = groups.get(name) ?? {
            name,
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            actualUsd: 0,
            estimatedUsd: 0,
            unknownCosts: 0,
          };
          group.requests++;
          group.inputTokens += row.inputTokens;
          group.outputTokens += row.outputTokens;
          group.cachedTokens += row.cachedTokens ?? 0;
          if (row.costUsd == null) group.unknownCosts++;
          else if (row.estimatedCost) group.estimatedUsd += row.costUsd;
          else group.actualUsd += row.costUsd;
          groups.set(name, group);
        }
        return {
          groups: [...groups.values()],
          allowanceNote: 'Web preview: subscription and credit balances are unavailable.',
        };
      },
      rotateKey: async (id) => {
        await deps.before();
        const key = gatewayKeys.find((key) => key.id === id && !key.revokedAt);
        if (!key) throw new Error('Unknown or revoked Gateway key.');
        return {
          key: { id: key.id, name: key.name, profile: key.profile },
          secret: 'ferry-gw-mock-rotated',
        };
      },
      testConnection: async ({ id, approvedCostUsd }) => {
        const key = gatewayKeys.find((key) => key.id === id && !key.revokedAt);
        if (!key) throw new Error('Unknown or revoked Gateway key.');
        if (key.paidBackup && approvedCostUsd === undefined)
          throw new Error('Use a free-only key or explicitly approve a test cost ceiling.');
        gatewaySettings.enabled = true;
        const model = (await client.gateway.routing(id)).eligible[0]?.modelRef;
        if (!model)
          return {
            ok: false,
            requestId: null,
            model: null,
            message: 'Connect a provider with a free route before testing.',
          };
        const record: GatewayRequestRecord = {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          keyId: id,
          keyName: key.name,
          requestedModel: 'ferry/auto',
          modelRef: model,
          providerId: model.split('/')[0] ?? null,
          status: 'ok',
          inputTokens: 8,
          outputTokens: 2,
          latencyMs: 120,
          error: null,
          outcome: 'completed',
          firstResponseMs: 80,
          cachedTokens: 0,
          costUsd: 0,
          estimatedCost: false,
          attempts: [{ model, status: 'served', durationMs: 120 }],
        };
        gatewayRequests.unshift(record);
        key.lastUsedAt = record.at;
        key.usage.requests++;
        key.usage.successfulRequests++;
        key.usage.inputTokens += 8;
        key.usage.outputTokens += 2;
        deps.emitter.emit('gateway.request', record);
        return {
          ok: true,
          requestId: record.id,
          model,
          message:
            'Fixture request completed in web preview. Desktop setup sends a real request through your key.',
        };
      },
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
    profiles: createProfilesDomain(runtime.store, deps, {
      isGatewayProfileReferenced: (id: string) => gatewayKeys.some((key) => key.profile === id),
    }),
    settings: createSettingsDomain(runtime.store, deps),
    optimizer: createOptimizerDomain(runtime.store, deps),
    delegation: createDelegationDomain(runtime.store, deps),
    skills: createSkillsDomain(runtime.store, deps),
    mcp: createMcpDomain(runtime.store, deps),
    cliConnections: createCliConnectionsDomain(runtime.store, deps),
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
