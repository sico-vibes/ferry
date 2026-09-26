import {
  createStepGenerator,
  type AgentEvent,
  type GeneratedStep,
  type StepGeneratorInput,
} from '@ferry/agent';
import type { RawCallObservation } from '@ferry/providers';
import {
  ProviderIdSchema,
  ProviderSchema,
  OAuthProviderIdSchema,
  UsageRecordSchema,
  QuotaObservationSchema,
  newId,
  type ModelInfo,
  type Profile,
  type Provider,
  type StepKind,
  type UsageRecord,
} from '@ferry/shared';
import { scoreModels, type CapacityView } from '@ferry/router';
import { oauthModelCatalog, streamOAuthStep } from '@ferry/oauth';
import type { FerryServices } from './services.js';

const providerKeyPresence = new WeakMap<FerryServices, Map<string, boolean>>();

export function invalidateSessionProviderKeyCache(
  services: FerryServices,
  providerId: string,
): void {
  providerKeyPresence.get(services)?.delete(providerId);
}

function hasProviderKey(services: FerryServices, providerId: string): boolean {
  let cache = providerKeyPresence.get(services);
  if (!cache) {
    cache = new Map();
    providerKeyPresence.set(services, cache);
  }
  let present = cache.get(providerId);
  if (present === undefined) {
    present = Boolean(services.providerKeys.get(providerId));
    cache.set(providerId, present);
  }
  return present;
}

/** Narrow binding seam: provider execution and durable usage belong to Core services. */
export interface ModelGateway {
  streamStep(req: StepGeneratorInput, signal: AbortSignal): Promise<GeneratedStep>;
  resolveCandidates(profile: Profile, stepKind: StepKind): ModelInfo[];
  recordHandoff(sessionId: string, reason: string): void;
}
export interface UsageSink {
  record(record: UsageRecord): void;
}

export function createSessionDependencies(
  services: FerryServices,
  emit: (event: AgentEvent) => void,
): {
  gateway: ModelGateway;
  usage: UsageSink;
  capacity: () => CapacityView;
  providers: () => Provider[];
  apiKeys: Record<string, string>;
  providerFetch: typeof globalThis.fetch;
} {
  const apiKeys: Record<string, string> = {};
  const loadedApiKeys = new Set<string>();
  const providerBaseUrls = Object.fromEntries(
    services.catalog.providers.flatMap(({ provider }) => {
      const envName = `FERRY_PROVIDER_BASE_URL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const baseUrl = services.env[envName];
      return baseUrl ? [[provider, baseUrl]] : [];
    }),
  );
  const providers = (): Provider[] => [
    ...services.catalog.providers.map(
      ({ provider, name, tag, data_use, terms_note, signup_url, docs_url, verified_at }) => {
        const id = ProviderIdSchema.parse(provider);
        const saved = services.providers.get(id);
        const keyPresent = hasProviderKey(services, id);
        const keyStatus: Provider['keyStatus'] = keyPresent
          ? (saved?.keyStatus ?? 'unchecked')
          : 'missing';
        const cooldown = services.cooldowns.get(id);
        const activeCooldown =
          cooldown && Date.parse(cooldown.until) > services.clock.now().getTime();
        return ProviderSchema.parse({
          id,
          name,
          tag,
          kind: tag === 'subscription_cli' ? 'cli' : 'api',
          brand: null,
          keyStatus,
          enabled: saved?.enabled ?? keyPresent,
          health: activeCooldown
            ? 'cooldown'
            : saved?.health === 'cooldown'
              ? 'ok'
              : (saved?.health ?? 'unknown'),
          cooldownUntil: activeCooldown ? cooldown.until : null,
          dataUse: data_use,
          termsNote: terms_note,
          signupUrl: signup_url,
          docsUrl: docs_url,
          verifiedAt: verified_at,
          modelCount: saved?.availableModels?.length ?? 0,
          ...(saved?.availableModels
            ? { availableModels: saved.availableModels, modelCount: saved.availableModels.length }
            : {}),
          modelsVerifiedAt: saved?.modelsVerifiedAt ?? null,
          windows: services.quota.getWindows(id),
          stepsLeftToday: services.quota.stepsLeft(id),
        });
      },
    ),
    ...OAuthProviderIdSchema.options.map((id) => {
      const saved = services.providers.get(id);
      return ProviderSchema.parse({
        id,
        name:
          id === 'anthropic'
            ? 'Anthropic Claude Pro/Max'
            : id === 'openai-codex'
              ? 'OpenAI ChatGPT'
              : 'GitHub Copilot',
        tag: 'subscription_oauth',
        kind: 'api',
        brand: null,
        keyStatus: saved?.keyStatus ?? 'missing',
        enabled: saved?.enabled ?? false,
        health: saved?.health ?? 'unknown',
        cooldownUntil: null,
        dataUse: null,
        termsNote: 'Unofficial subscription OAuth · account suspension risk',
        signupUrl: null,
        docsUrl: null,
        verifiedAt: null,
        modelCount: oauthModelCatalog.filter((model) => model.providerId === id).length,
        windows: [],
        stepsLeftToday: null,
      });
    }),
  ];
  const capacity = (): CapacityView => ({
    providers: providers(),
    now: services.clock.now().toISOString(),
  });
  const usage: UsageSink = {
    record(raw) {
      services.quota.recordUsage(UsageRecordSchema.parse(raw));
      // QuotaEngine subscribers publish the authoritative quota.update summary.
    },
  };
  const providerFetch: typeof globalThis.fetch = async (input, init) =>
    globalThis.fetch(input, init);
  const observe = (observation: RawCallObservation) => {
    const providerId = ProviderIdSchema.parse(observation.providerId);
    const limits = services.catalog.providers.find((item) => item.provider === providerId);
    const model = services.catalog.models.find((item) => item.ref === observation.modelRef);
    const now = services.clock.now();
    for (const header of Object.entries(observation.rateLimitHeaders)) {
      const [key, value] = header;
      const remaining = key.includes('remaining') ? Number(value) : null;
      const limit = key.includes('limit') && !key.includes('remaining') ? Number(value) : null;
      if (remaining === null && limit === null) continue;
      const definitions =
        limits?.windows.filter(
          (window) =>
            window.metric === (key.includes('token') ? 'tokens' : 'requests') &&
            (window.scope === 'provider' ||
              window.model === model?.ref.slice(providerId.length + 1)),
        ) ?? [];
      for (const definition of definitions) {
        const observationRecord = QuotaObservationSchema.safeParse({
          id: newId('quota'),
          providerId,
          windowId: `${providerId}:${definition.scope}:${definition.model ?? '*'}:${definition.metric}:${definition.kind}`,
          metric: definition.metric,
          ...(remaining !== null && limit !== null
            ? { value: Math.max(0, limit - remaining) }
            : {}),
          limit,
          remaining,
          resetAt: null,
          source: 'header',
          observedAt: now.toISOString(),
          ...(observation.statusCode === 429 ? { statusCode: 429 } : {}),
        });
        if (observationRecord.success) services.quota.observe(observationRecord.data);
      }
    }
    if (observation.statusCode === 429) {
      const retryAfter = observation.rateLimitHeaders['retry-after'];
      const retryTimestamp = retryAfter
        ? Number.isFinite(Number(retryAfter))
          ? new Date(now.getTime() + Number(retryAfter) * 1000).toISOString()
          : new Date(retryAfter).toISOString()
        : undefined;
      const cooldown = services.quota.noteFailure(
        providerId,
        observation.modelRef,
        providerId,
        '429',
        retryTimestamp,
      );
      if (cooldown.cooldownUntil)
        services.cooldowns.put({ id: providerId, until: cooldown.cooldownUntil });
      const saved = services.providers.get(providerId);
      if (saved)
        services.providers.put({
          ...saved,
          health: 'cooldown',
          cooldownUntil: cooldown.cooldownUntil ?? null,
        });
    } else if (observation.statusCode !== null && observation.statusCode < 400) {
      services.quota.noteSuccess(providerId, observation.modelRef, providerId);
    }
  };
  const gateway: ModelGateway = {
    resolveCandidates(profile, stepKind) {
      const available = services.catalog.providers.flatMap(
        ({ provider }) => services.providers.get(provider)?.availableModels ?? [],
      );
      const oauthRoutingEnabled =
        (services.settings.get('global') as { allowSubscriptionOAuthRouting?: boolean } | undefined)
          ?.allowSubscriptionOAuthRouting === true;
      const oauthModels = oauthRoutingEnabled
        ? oauthModelCatalog.filter((model) => services.providers.get(model.providerId)?.enabled)
        : [];
      const candidates = [...available, ...oauthModels];
      const eligible = new Set(
        scoreModels({
          models: candidates,
          providers: providers(),
          capacity: capacity(),
          profile,
          step: stepKind,
          estimate: { inputTokens: 1, requiresTools: false },
        }).map((candidate) => candidate.ref),
      );
      return candidates.filter((model) => eligible.has(model.ref));
    },
    recordHandoff(sessionId, reason) {
      services.handoffs.put({ id: newId('handoff'), sessionId, reason });
    },
    async streamStep(req, signal) {
      const providerId = req.model.providerId;
      if (OAuthProviderIdSchema.safeParse(providerId).success)
        return await streamOAuthStep(services.secrets, { ...req, signal });
      if (!loadedApiKeys.has(providerId)) {
        loadedApiKeys.add(providerId);
        // The key reference is authoritative; look up the secret only for the selected candidate.
        if (hasProviderKey(services, providerId)) {
          const key = await services.secrets.get(providerId);
          if (key) apiKeys[providerId] = key;
        }
      }
      const generator = createStepGenerator(
        { apiKeys, providerBaseUrls, providerFetch, emit, onObservation: observe },
        req.model,
        req.messages.at(-1)?.sessionId ?? '',
      );
      try {
        return await generator({ ...req, signal });
      } catch (error) {
        if (isUnavailableModelError(error)) {
          const saved = services.providers.get(providerId);
          if (saved?.availableModels) {
            const availableModels = saved.availableModels.filter(
              (model) => model.ref !== req.model.ref,
            );
            services.providers.put({
              ...saved,
              availableModels,
              modelCount: availableModels.length,
              modelsVerifiedAt: services.clock.now().toISOString(),
            });
          }
        }
        throw error;
      }
    },
  };
  return { gateway, usage, capacity, providers, apiKeys, providerFetch };
}

function isUnavailableModelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  const status = Number(
    candidate.statusCode ?? candidate.status ?? candidate.response?.status ?? 0,
  );
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return (
    status === 404 ||
    status === 410 ||
    /model_not_found|not found for account|end of life|no longer available/i.test(message)
  );
}
