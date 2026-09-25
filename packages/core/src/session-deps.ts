import {
  createStepGenerator,
  type AgentEvent,
  type GeneratedStep,
  type StepGeneratorInput,
} from '@ferry/agent';
import { createObservedFetch } from '@ferry/providers';
import {
  ProviderIdSchema,
  ProviderSchema,
  UsageRecordSchema,
  type ModelInfo,
  type Profile,
  type Provider,
  type StepKind,
  type UsageRecord,
} from '@ferry/shared';
import { scoreModels, type CapacityView } from '@ferry/router';
import type { FerryServices } from './services.js';

/** The W2 binding seam: keep provider execution and quota recording out of domain handlers. */
export interface ModelGateway {
  streamStep(req: StepGeneratorInput, signal: AbortSignal): Promise<GeneratedStep>;
  resolveCandidates(profile: Profile, stepKind: StepKind): ModelInfo[];
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
  const providerBaseUrls = Object.fromEntries(
    services.catalog.providers.flatMap(({ provider }) => {
      const envName = `FERRY_PROVIDER_BASE_URL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const baseUrl = services.env[envName];
      return baseUrl ? [[provider, baseUrl]] : [];
    }),
  );
  for (const limits of services.catalog.providers) {
    const envName = `FERRY_PROVIDER_API_KEY_${limits.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const key = (await services.secrets.get(limits.provider)) ?? services.env[envName];
    if (key) apiKeys[limits.provider] = key;
  }
  const savedProviders = services.settings.get('providers');
  const saved = Array.isArray(savedProviders)
    ? savedProviders.flatMap((item) => {
        const parsed = ProviderSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const byId = new Map(saved.map((provider) => [provider.id, provider]));
  const providerList = services.catalog.providers.map((limits) => {
    const id = ProviderIdSchema.parse(limits.provider);
    const stored = byId.get(id);
    if (stored) return stored;
    const hasKey = Boolean(apiKeys[limits.provider]);
    return ProviderSchema.parse({
      id,
      name: limits.name,
      tag: limits.tag,
      kind: 'api',
      brand: null,
      keyStatus: hasKey ? 'valid' : 'missing',
      enabled: hasKey,
      health: 'unknown',
      cooldownUntil: null,
      dataUse: limits.data_use,
      termsNote: limits.terms_note,
      signupUrl: limits.signup_url,
      docsUrl: limits.docs_url,
      verifiedAt: limits.verified_at,
      modelCount: services.catalog.models.filter((model) => model.providerId === limits.provider)
        .length,
      windows: [],
      stepsLeftToday: null,
    });
  });
  const providers = () => providerList;
  const capacity = (): CapacityView => ({
    providers: providerList,
    now: services.clock.now().toISOString(),
  });
  const usage: UsageSink = {
    record(raw) {
      const record = UsageRecordSchema.parse(raw);
      services.quota.recordUsage(record);
      emit({
        type: 'quota.updated',
        observation: {
          providerId: record.providerId,
          modelRef: record.modelRef,
          startedAt: Date.parse(record.occurredAt),
          latencyMs: record.latencyMs ?? 0,
          statusCode: null,
          requestBytes: null,
          rateLimitHeaders: {},
          errorKind: record.errorKind ?? null,
        },
      });
    },
  };
  const providerFetch: typeof globalThis.fetch = async (input, init) => {
    const original = new URL(input instanceof Request ? input.url : String(input));
    const providerId = original.hostname.includes('generativelanguage')
      ? 'gemini'
      : original.hostname.includes('anthropic')
        ? 'anthropic'
        : original.hostname.includes('openrouter')
          ? 'openrouter'
          : original.hostname.includes('openai')
            ? 'openai'
            : undefined;
    const base = providerId
      ? services.env[`FERRY_PROVIDER_BASE_URL_${providerId.toUpperCase()}`]
      : undefined;
    if (!base) return globalThis.fetch(input, init);
    const targetBase = new URL(base);
    original.protocol = targetBase.protocol;
    original.host = targetBase.host;
    const suffix = original.pathname.split('/').filter(Boolean).slice(-2).join('/');
    original.pathname = `${targetBase.pathname.replace(/\/$/, '')}/${suffix}`;
    return globalThis.fetch(original, init);
  };
  const gateway: ModelGateway = {
    resolveCandidates(profile, stepKind) {
      const ranked = scoreModels({
        models: services.catalog.models,
        providers: providerList,
        capacity: capacity(),
        profile,
        step: stepKind,
        estimate: { inputTokens: 1, requiresTools: false },
      });
      const eligible = new Set(ranked.map((candidate) => candidate.ref));
      return services.catalog.models.filter((model) => eligible.has(model.ref));
    },
    async streamStep(req, signal) {
      const observed = createObservedFetch(
        () => undefined,
        { providerId: req.model.providerId, model: req.model.ref },
        providerFetch,
      );
      const generator = createStepGenerator(
        {
          apiKeys,
          providerBaseUrls,
          providerFetch: observed,
          emit,
          onObservation: () => undefined,
        },
        req.model,
        req.messages.at(-1)?.sessionId ?? '',
      );
      return await generator({ ...req, signal });
    },
  };
  return { gateway, usage, capacity, providers, apiKeys, providerFetch };
}
