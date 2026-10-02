import {
  ModelCandidateSchema,
  ModelInfoSchema,
  ModelRefSchema,
  ProviderIdSchema,
  SessionIdSchema,
  SessionSchema,
} from '@ferry/shared';
import { oauthModelCatalog } from '@ferry/oauth';
import { modelSupportsTools } from '@ferry/router';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { getModelDiscovery } from './model-discovery.js';
import { preserveCatalogBillingMetadata } from '../model-billing-metadata.js';
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
  const modelsFor = (id: string) => {
    const cached = services.models.list(id);
    const refs = new Set(cached.map((model) => model.ref));
    return [
      ...cached,
      ...services.catalog.models.filter((model) => model.providerId === id && !refs.has(model.ref)),
    ];
  };
  host.registerDomain('models', {
    list(rawProviderId?: unknown) {
      const providerId =
        rawProviderId === undefined ? undefined : ProviderIdSchema.parse(rawProviderId);
      const enabled = services.catalog.providers
        .filter((provider) => providerId === undefined || provider.provider === providerId)
        .map((provider) => provider.provider)
        .filter((id) => services.providers.get(id)?.enabled ?? false);

      enabled.forEach((id) => void modelDiscovery.refreshIfStale(id));
      const cachedModels = enabled.flatMap(modelsFor);
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .filter((model) => providerId === undefined || model.providerId === providerId)
        .map((model) => ModelInfoSchema.parse(model));
      return preserveCatalogBillingMetadata(
        [...cachedModels, ...oauthModels].map((model) => ModelInfoSchema.parse(model)),
        services.catalog.models,
      );
    },
    page(rawQuery?: unknown) {
      const { offset, limit, query, filters, sort } = ModelListQuerySchema.parse(rawQuery ?? {});
      const providerId = filters.providerId;
      const enabled = services.catalog.providers
        .filter((provider) => providerId === undefined || provider.provider === providerId)
        .map((provider) => provider.provider)
        .filter((id) => services.providers.get(id)?.enabled ?? false);

      enabled.forEach((id) => void modelDiscovery.refreshIfStale(id));
      const cachedModels = enabled.flatMap(modelsFor);
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .map((model) => ModelInfoSchema.parse(model));

      const needle = query.toLocaleLowerCase();
      const listedModels = preserveCatalogBillingMetadata(
        [...cachedModels, ...oauthModels].map((model) => ModelInfoSchema.parse(model)),
        services.catalog.models,
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
      services.catalog.providers.forEach(({ provider }) => {
        if (services.providers.get(provider)?.enabled) void modelDiscovery.refreshIfStale(provider);
      });
      const cachedModels = services.catalog.providers.flatMap(({ provider, key_required }) => {
        const saved = services.providers.get(provider);
        const hasKey = Boolean(services.providerKeys.get(provider));
        const enabled = saved?.enabled ?? (hasKey || key_required === false);
        return enabled && !saved?.freeTierUnsupported && (hasKey || key_required === false)
          ? modelsFor(provider)
          : [];
      });
      const models = preserveCatalogBillingMetadata(cachedModels, services.catalog.models);
      const enabled = models.filter((model) => modelSupportsTools(model));
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .map((model) => ModelInfoSchema.parse(model))
        .filter((model) => modelSupportsTools(model));
      const choices = [...enabled, ...oauthModels];
      return choices.map((model, index) => {
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
        const available =
          services.catalog.models.some((model) => model.ref === modelRef) ||
          services.catalog.providers.some(({ provider }) =>
            services.models.list(provider).some((model) => model.ref === modelRef),
          ) ||
          oauthModelCatalog.some((model) => model.ref === modelRef);
        if (!available) throw new Error(`Unknown model: ${modelRef}`);
      }
      const updated = SessionSchema.parse({
        ...session,
        pinnedModelRef: modelRef === 'auto' ? null : modelRef,
        ...(modelRef === 'auto' ? {} : { modelRef }),
        updatedAt: services.clock.now().toISOString(),
      });
      services.sessions.put(updated);
      host.emit('session.updated', updated);
      host.emit('session.status', updated);
    },
  });
}
