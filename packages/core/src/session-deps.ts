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
import type { FerryServices } from './services.js';

/** Narrow binding seam: provider execution and durable usage belong to Core services. */
export interface ModelGateway {
  streamStep(req: StepGeneratorInput, signal: AbortSignal): Promise<GeneratedStep>;
  resolveCandidates(profile: Profile, stepKind: StepKind): ModelInfo[];
  recordHandoff(sessionId: string, reason: string): void;
}
export interface UsageSink {
  record(record: UsageRecord): void;
}

export async function createSessionDependencies(
  services: FerryServices,
  emit: (event: AgentEvent) => void,
): Promise<{
  gateway: ModelGateway;
  usage: UsageSink;
  capacity: () => CapacityView;
  providers: () => Provider[];
  apiKeys: Record<string, string>;
  providerFetch: typeof globalThis.fetch;
}> {
  const apiKeys: Record<string, string> = {};
  for (const limits of services.catalog.providers) {
    // The provider key reference is the authority; secrets never come from environment values.
    if (!services.providerKeys.get(limits.provider)) continue;
    const key = await services.secrets.get(limits.provider);
    if (key) apiKeys[limits.provider] = key;
  }
  const providerBaseUrls = Object.fromEntries(
    services.catalog.providers.flatMap(({ provider }) => {
      const envName = `FERRY_PROVIDER_BASE_URL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const baseUrl = services.env[envName];
      return baseUrl ? [[provider, baseUrl]] : [];
    }),
  );
  const providers = (): Provider[] =>
    services.catalog.providers.map(
      ({ provider, name, tag, data_use, terms_note, signup_url, docs_url, verified_at }) => {
        const id = ProviderIdSchema.parse(provider);
        const saved = services.providers.get(id);
        const keyRef = services.providerKeys.get(id);
        const keyStatus: Provider['keyStatus'] = keyRef
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
          enabled: saved?.enabled ?? Boolean(keyRef),
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
          modelCount: services.catalog.models.filter((model) => model.providerId === id).length,
          windows: services.quota.getWindows(id),
          stepsLeftToday: services.quota.stepsLeft(id),
        });
      },
    );
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
      const eligible = new Set(
        scoreModels({
          models: services.catalog.models,
          providers: providers(),
          capacity: capacity(),
          profile,
          step: stepKind,
          estimate: { inputTokens: 1, requiresTools: false },
        }).map((candidate) => candidate.ref),
      );
      return services.catalog.models.filter((model) => eligible.has(model.ref));
    },
    recordHandoff(sessionId, reason) {
      services.handoffs.put({ id: newId('handoff'), sessionId, reason });
    },
    async streamStep(req, signal) {
      const generator = createStepGenerator(
        { apiKeys, providerBaseUrls, providerFetch, emit, onObservation: observe },
        req.model,
        req.messages.at(-1)?.sessionId ?? '',
      );
      return await generator({ ...req, signal });
    },
  };
  return { gateway, usage, capacity, providers, apiKeys, providerFetch };
}
