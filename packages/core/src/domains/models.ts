import {
  ModelCandidateSchema,
  ModelInfoSchema,
  ModelRefSchema,
  ProviderIdSchema,
  SessionIdSchema,
  SessionSchema,
  newId,
  isCliModelVerified,
  isOpenCodeAppModel,
} from '@ferry/shared';
import { oauthModelCatalog } from '@ferry/oauth';
import { zenModel, zenProvider, hasZenCliAccess } from '../zen-cli.js';
import { modelSupportsTools } from '@ferry/router';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { hasUsableProviderKey } from '../services.js';
import { getModelDiscovery, type ModelDiscovery } from './model-discovery.js';
import { preserveCatalogBillingMetadata } from '../model-billing-metadata.js';
import { getGatewayController } from '../gateway.js';
import { cliOptionError, getCliBroker } from '../cli-broker.js';
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

function cachedProviderModels(
  services: FerryServices,
  discovery: ModelDiscovery,
  providerId?: string,
) {
  return services.catalog.providers.flatMap(({ provider: id }) => {
    if (providerId !== undefined && id !== providerId) return [];
    const saved = services.providers.get(id);
    if (!saved?.enabled) return [];
    void discovery.refreshIfStale(id).catch(() => undefined);
    const excluded = new Set(saved.excludedModelRefs ?? []);
    return services.models
      .list(id)
      .filter((model) => !excluded.has(model.ref))
      .map((model) => ({
        ...model,
        verified: model.verified ?? Boolean(saved.modelsVerifiedAt),
        verifiedAt: model.verifiedAt ?? saved.modelsVerifiedAt ?? null,
      }))
      .map((model) => zenModel(services, model));
  });
}

const CLI_CONNECTION_IDS = new Set(['codex-cli', 'claude-code-cli', 'opencode-cli']);

export function register(host: CoreHost, services: FerryServices): void {
  const providerForModel = (id: string) => {
    const saved = services.providers.get(id);
    return saved ? zenProvider(services, saved) : undefined;
  };
  const modelDiscovery = getModelDiscovery(host, services);
  const emit = (method: string, payload: unknown) => {
    host.emit(method, payload);
  };
  // CLI inventory is cached discovery only; it never blocks on a probe from the request path.
  const cliModels = (providerId?: string) =>
    providerId !== undefined && !CLI_CONNECTION_IDS.has(providerId)
      ? []
      : getCliBroker(services, emit)
          .models()
          .filter((model) => providerId === undefined || model.providerId === providerId);
  const failingModels = () =>
    new Set(
      services.requestFailures
        .summary(
          [
            ...new Set([
              ...services.catalog.providers.map((provider) => provider.provider),
              ...services.providers.list().map((provider) => provider.id),
            ]),
          ].map((id) => ({ id: ProviderIdSchema.parse(id) })),
          services.clock.now(),
        )
        .providers.flatMap((provider) =>
          provider.models.filter((model) => model.failing).map((model) => model.modelRef),
        ),
    );
  host.registerDomain('models', {
    list(rawProviderId?: unknown) {
      const providerId =
        rawProviderId === undefined ? undefined : ProviderIdSchema.parse(rawProviderId);
      const failing = failingModels();
      const cachedModels = cachedProviderModels(services, modelDiscovery, providerId);
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .filter((model) => providerId === undefined || model.providerId === providerId)
        .map((model) => ModelInfoSchema.parse({ ...model, verified: false, verifiedAt: null }));
      return [
        ...preserveCatalogBillingMetadata(
          [...cachedModels, ...oauthModels].map((model) =>
            ModelInfoSchema.parse({ ...model, failing: failing.has(model.ref) }),
          ),
          services.catalog.models,
          providerForModel,
          (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
        ),
        // Installed-CLI models keep their discovered capability metadata and verification state.
        ...cliModels(providerId).map((model) =>
          ModelInfoSchema.parse({ ...model, failing: failing.has(model.ref) }),
        ),
      ];
    },
    page(rawQuery?: unknown) {
      const { offset, limit, query, filters, sort } = ModelListQuerySchema.parse(rawQuery ?? {});
      const providerId = filters.providerId;
      const failing = failingModels();
      const cachedModels = cachedProviderModels(services, modelDiscovery, providerId);
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .map((model) => ModelInfoSchema.parse({ ...model, verified: false, verifiedAt: null }));

      const needle = query.toLocaleLowerCase();
      const listedModels = [
        ...preserveCatalogBillingMetadata(
          [...cachedModels, ...oauthModels].map((model) =>
            ModelInfoSchema.parse({ ...model, failing: failing.has(model.ref) }),
          ),
          services.catalog.models,
          providerForModel,
          (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
        ),
        ...cliModels(providerId).map((model) =>
          ModelInfoSchema.parse({ ...model, failing: failing.has(model.ref) }),
        ),
      ];
      const filtered = listedModels
        .filter((model) => providerId === undefined || model.providerId === providerId)
        .filter((model) => filters.tier === undefined || model.tier === filters.tier)
        .filter((model) => filters.free === undefined || model.free === filters.free)
        .filter(
          (model) =>
            !needle ||
            `${model.name} ${model.ref} ${model.providerId}`.toLocaleLowerCase().includes(needle),
        )
        .map((model) => ModelInfoSchema.parse({ ...model, failing: failing.has(model.ref) }));
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
      const failing = failingModels();
      const sessionId = SessionIdSchema.parse(rawSessionId);
      const session = services.sessions.get(sessionId);
      if (!session) return [];
      const cachedModels = services.catalog.providers.flatMap(({ provider, key_required }) => {
        const saved = services.providers.get(provider);
        const hasKey = hasUsableProviderKey(services, provider);
        const enabled = saved?.enabled ?? (hasKey || key_required === false);
        return enabled &&
          (!saved?.freeTierUnsupported || (provider === 'opencode' && hasZenCliAccess(services))) &&
          (hasKey || key_required === false)
          ? services.models.list(provider).map((model) => zenModel(services, model))
          : [];
      });
      const models = preserveCatalogBillingMetadata(
        cachedModels,
        services.catalog.models,
        providerForModel,
        (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
      );
      const enabled = models.filter(
        (model) => modelSupportsTools(model) && !isOpenCodeAppModel(model),
      );
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .map((model) => ModelInfoSchema.parse({ ...model, failing: failing.has(model.ref) }))
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
          const known =
            services.catalog.providers
              .flatMap(({ provider }) => services.models.list(provider))
              .find((model) => model.ref === modelRef) ??
            services.catalog.models.find((model) => model.ref === modelRef);
          if (known && isOpenCodeAppModel(zenModel(services, known)))
            throw new Error('Available in the OpenCode app. Use ferry run opencode --native.');
          // An installed-CLI model is a real selectable target once it is discovered, even though it
          // is not in the API catalog. Selection additionally requires the native surface opted in and
          // a real per-model verification receipt; dispatch re-checks both.
          const cli = getCliBroker(services, emit).model(modelRef);
          if (cli) {
            if (!cli.connection.surfaces.native)
              throw new Error(
                `${cli.connection.kind} native surface is not enabled. Enable Native in Providers & keys before selecting ${modelRef}.`,
              );
            if (!isCliModelVerified(cli.connection, cli.model.ref))
              throw new Error(
                `${cli.model.name} is not verified on ${cli.connection.kind}. Run Verify for this model before selecting it.`,
              );
          }
          const available =
            services.catalog.models.some((model) => model.ref === modelRef) ||
            services.catalog.providers.some(({ provider }) =>
              services.models.list(provider).some((model) => model.ref === modelRef),
            ) ||
            oauthModelCatalog.some((model) => model.ref === modelRef) ||
            cli !== undefined;
          if (!available) throw new Error(`Unknown model: ${modelRef}`);
        }
      }
      // Reset incompatible stored CLI options for the newly selected CLI model so a model change
      // never dispatches an option the model no longer advertises.
      let cliOptions = session.cliOptions;
      if (modelRef !== 'auto') {
        const discoveredModel = getCliBroker(services, emit).model(modelRef);
        const existing = cliOptions?.[modelRef];
        if (
          discoveredModel &&
          existing &&
          cliOptionError(modelRef, discoveredModel.model, existing)
        ) {
          const next = { ...(cliOptions ?? {}) };
          Reflect.deleteProperty(next, modelRef);
          cliOptions = next;
        }
      }
      const updated = SessionSchema.parse({
        ...session,
        pinnedModelRef: modelRef === 'auto' ? null : modelRef,
        ...(cliOptions === session.cliOptions ? {} : { cliOptions }),
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
