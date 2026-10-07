import {
  ModelCandidateSchema,
  ModelInfoSchema,
  ModelRefSchema,
  ProviderIdSchema,
  SessionIdSchema,
  SessionSchema,
  newId,
} from '@ferry/shared';
import { oauthModelCatalog } from '@ferry/oauth';
import { modelSupportsTools } from '@ferry/router';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { hasUsableProviderKey } from '../services.js';
import { getModelDiscovery } from './model-discovery.js';
import { preserveCatalogBillingMetadata } from '../model-billing-metadata.js';
import { getGatewayController } from '../gateway.js';
import { z } from 'zod';

const ModelListQuerySchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(2_000).default(50),
  query: z.string().trim().default(''),
  filters: z
    .object({
      providerId: ProviderIdSchema.optional(),
      tier: z.enum(['T1', 'T2', 'T3']).optional(),
      free: z.boolean().optional(),
    })
    .default({}),
  sort: z
    .object({
      key: z
        .enum([
          'name',
          'providerId',
          'tier',
          'contextWindow',
          'toolCalling',
          'free',
          'priceInPerM',
          'priceOutPerM',
        ])
        .default('name'),
      ascending: z.boolean().default(true),
    })
    .default({ key: 'name', ascending: true }),
});

export function register(host: CoreHost, services: FerryServices): void {
  const modelDiscovery = getModelDiscovery(host, services);
  host.registerDomain('models', {
    async list(rawProviderId?: unknown) {
      const providerId =
        rawProviderId === undefined ? undefined : ProviderIdSchema.parse(rawProviderId);
      const enabled = services.catalog.providers
        .filter((provider) => providerId === undefined || provider.provider === providerId)
        .map((provider) => provider.provider)
        .filter((id) => services.providers.get(id)?.enabled ?? false);

      await Promise.all(enabled.map((id) => modelDiscovery.refreshIfStale(id)));
      const cachedModels = enabled.flatMap((id) => services.models.list(id));
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .filter((model) => providerId === undefined || model.providerId === providerId)
        .map((model) => ModelInfoSchema.parse(model));
      return preserveCatalogBillingMetadata(
        [...cachedModels, ...oauthModels].map((model) => ModelInfoSchema.parse(model)),
        services.catalog.models,
        (id) => services.providers.get(id),
        (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
      );
    },
    async page(rawQuery?: unknown) {
      const { offset, limit, query, filters, sort } = ModelListQuerySchema.parse(rawQuery ?? {});
      const providerId = filters.providerId;
      const enabled = services.catalog.providers
        .filter((provider) => providerId === undefined || provider.provider === providerId)
        .map((provider) => provider.provider)
        .filter((id) => services.providers.get(id)?.enabled ?? false);

      await Promise.all(enabled.map((id) => modelDiscovery.refreshIfStale(id)));
      const cachedModels = enabled.flatMap((id) => services.models.list(id));
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .map((model) => ModelInfoSchema.parse(model));

      const needle = query.toLocaleLowerCase();
      const listedModels = preserveCatalogBillingMetadata(
        [...cachedModels, ...oauthModels].map((model) => ModelInfoSchema.parse(model)),
        services.catalog.models,
        (id) => services.providers.get(id),
        (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
      );
      const filtered = listedModels
        .filter((model) => providerId === undefined || model.providerId === providerId)
        .filter((model) => filters.tier === undefined || model.tier === filters.tier)
        .filter((model) => filters.free === undefined || model.free === filters.free)
        .filter(
          (model) =>
            !needle ||
            `${model.name} ${model.ref} ${model.providerId}`.toLocaleLowerCase().includes(needle),
        )
        .map((model) => ModelInfoSchema.parse(model));
      const direction = sort.ascending ? 1 : -1;
      filtered.sort((left, right) => {
        const a = left[sort.key];
        const b = right[sort.key];
        const order =
          typeof a === 'string' && typeof b === 'string'
            ? a.localeCompare(b)
            : Number(a ?? -1) - Number(b ?? -1);
        return direction * (order || left.ref.localeCompare(right.ref));
      });
      return { items: filtered.slice(offset, offset + limit), total: filtered.length };
    },
    candidates(rawSessionId: unknown) {
      const sessionId = SessionIdSchema.parse(rawSessionId);
      const session = services.sessions.get(sessionId);
      if (!session) return [];
      const cachedModels = services.catalog.providers.flatMap(({ provider, key_required }) => {
        const saved = services.providers.get(provider);
        const hasKey = hasUsableProviderKey(services, provider);
        const enabled = saved?.enabled ?? (hasKey || key_required === false);
        return enabled && !saved?.freeTierUnsupported && (hasKey || key_required === false)
          ? services.models.list(provider)
          : [];
      });
      const models = preserveCatalogBillingMetadata(
        cachedModels,
        services.catalog.models,
        (id) => services.providers.get(id),
        (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
      );
      const enabled = models.filter((model) => modelSupportsTools(model));
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .map((model) => ModelInfoSchema.parse(model))
        .filter((model) => modelSupportsTools(model));
      const choices = [...enabled, ...oauthModels];
      const gatewayChoices = (getGatewayController(services)?.listKeys() ?? [])
        .filter((key) => !key.revokedAt)
        .map((key) =>
          ModelInfoSchema.parse({
            ref: `gateway/${key.id}`,
            providerId: 'gateway',
            name: key.name,
            tier: 'T1',
            contextWindow: 128_000,
            maxOutput: 8_192,
            toolCalling: true,
            reasoning: false,
            free: false,
            priceInPerM: null,
            priceOutPerM: null,
            gateway: {
              keyId: key.id,
              keyName: key.name,
              modelName:
                key.profile === 'none'
                  ? (key.allowedModels[0] ?? 'ferry/auto')
                  : `ferry/${key.profile}`,
            },
          }),
        );
      const allChoices = [...choices, ...gatewayChoices];
      return allChoices.map((model, index) => {
        const stepsLeft = services.quota.stepsLeft(model.providerId, model.ref);
        return ModelCandidateSchema.parse({
          ref: model.ref,
          score: choices.length - index,
          stepsLeft,
          explanation: `${model.tier} tool-capable · ${stepsLeft === null ? 'capacity unknown' : `${String(stepsLeft)} steps left`}`,
          selected: session.pinnedModelRef ? session.pinnedModelRef === model.ref : index === 0,
        });
      });
    },
    select(rawSessionId: unknown, rawModelRef: unknown) {
      const sessionId = SessionIdSchema.parse(rawSessionId);
      const modelRef = rawModelRef === 'auto' ? 'auto' : ModelRefSchema.parse(rawModelRef);
      const session = services.sessions.get(sessionId);
      if (!session) return;
      if (modelRef !== 'auto') {
        const gatewayMatch = /^gateway\/(.+)$/.exec(modelRef);
        if (gatewayMatch) {
          const keyId = gatewayMatch[1];
          if (!keyId) throw new Error('Invalid Gateway key reference');
          const key = getGatewayController(services)?.key(keyId);
          if (!key) throw new Error(`Unknown or revoked Gateway key: ${keyId}`);
        } else {
          const available =
            services.catalog.models.some((model) => model.ref === modelRef) ||
            services.catalog.providers.some(({ provider }) =>
              services.models.list(provider).some((model) => model.ref === modelRef),
            ) ||
            oauthModelCatalog.some((model) => model.ref === modelRef);
          if (!available) throw new Error(`Unknown model: ${modelRef}`);
        }
      }
      const updated = SessionSchema.parse({
        ...session,
        pinnedModelRef: modelRef === 'auto' ? null : modelRef,
        updatedAt: services.clock.now().toISOString(),
      });
      const previousModel = session.pinnedModelRef ?? 'auto';
      if (previousModel !== modelRef) {
        const midRun = services.sessions.get(sessionId)?.status === 'running';
        services.telemetry.modelSwitch({
          session_id: sessionId,
          kind: 'selection_change',
          from_model: previousModel,
          to_model: modelRef,
          reason: 'user selection',
          data: { who: 'user', mid_run: midRun },
        });
        services.telemetry.log({
          id: newId('evt'),
          ts: services.clock.now().toISOString(),
          level: 'info',
          source: 'ui',
          event: 'model.switch',
          session_id: sessionId,
          data: { who: 'user', from_model: previousModel, to_model: modelRef, mid_run: midRun },
        });
        if (session.pinnedModelRef !== updated.pinnedModelRef)
          services.telemetry.modelSwitch({
            session_id: sessionId,
            kind: updated.pinnedModelRef ? 'pin' : 'unpin',
            from_model: session.pinnedModelRef,
            to_model: updated.pinnedModelRef,
            reason: 'user selection',
            data: { who: 'user', mid_run: midRun },
          });
      }
      services.sessions.put(updated);
      host.emit('session.updated', updated);
      host.emit('session.status', updated);
    },
  });
}
