import {
  createStepGenerator,
  type AgentEvent,
  type GeneratedStep,
  type ModelHints,
  type StepGeneratorInput,
} from '@ferry/agent';
import type { RawCallObservation } from '@ferry/providers';
import type { TraceContext } from '@ferry/shared';
import {
  probe as probeProvider,
  ProviderKeyRotation,
  resolveProviderRequestOverrides,
} from '@ferry/providers';
import {
  ProviderIdSchema,
  ProviderSchema,
  RoutingSettingsSchema,
  UsageRecordSchema,
  QuotaObservationSchema,
  newId,
  type ModelInfo,
  type Profile,
  type Provider,
  type StepKind,
  type UsageRecord,
} from '@ferry/shared';
import {
  chainForProfile,
  isStrictFallbackNameEligible,
  modelSupportsTools,
  resolveFallbackChain,
  scoreModels,
  type ReliabilityObservation,
  type CapacityView,
  canProbeCooldown,
} from '@ferry/router';
import { oauthModelCatalog, streamOAuthStep } from '@ferry/oauth';
import { hasUsableProviderKey, recordProviderKeyFailure, type FerryServices } from './services.js';
import { z } from 'zod';

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
    present = hasUsableProviderKey(services, providerId);
    cache.set(providerId, present);
  }
  return present;
}

/** Narrow binding seam: provider execution and durable usage belong to Core services. */
export interface ModelGateway {
  streamStep(req: StepGeneratorInput, signal: AbortSignal): Promise<GeneratedStep>;
  providerAffinityKey(providerId: string, sessionId: string): string | undefined;
  providerKeyIds(providerId: string): readonly string[];
  unavailableProviderKeyIds(providerId: string, modelRef?: string): readonly string[];
  resolveCandidates(profile: Profile, stepKind: StepKind, inputTokens?: number): ModelInfo[];
  recordHandoff(sessionId: string, reason: string): void;
  probeHeuristicCooldowns(): Promise<void>;
}
export interface UsageSink {
  record(record: UsageRecord): void;
}

export function createSessionDependencies(
  services: FerryServices,
  emit: (event: AgentEvent) => void,
  traceContext?: TraceContext,
): {
  gateway: ModelGateway;
  usage: UsageSink;
  capacity: () => CapacityView;
  providers: () => Provider[];
  apiKeys: Record<string, string>;
  providerFetch: typeof globalThis.fetch;
  observe: (observation: RawCallObservation) => void;
} {
  const apiKeys: Record<string, string> = {};
  const providerKeyRotation = new ProviderKeyRotation();
  const selectedProviderKeys = new Map<string, { providerId: string; keyId: string }>();
  const keyRetryAfter = new Map<string, string>();
  const providerBaseUrls = Object.fromEntries(
    services.catalog.providers.flatMap(({ provider }) => {
      const envName = `FERRY_PROVIDER_BASE_URL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const baseUrl = services.env[envName];
      return baseUrl ? [[provider, baseUrl]] : [];
    }),
  );
  const providers = (): Provider[] => [
    ...services.catalog.providers.map(
      ({
        provider,
        name,
        tag,
        data_use,
        terms_note,
        signup_url,
        docs_url,
        verified_at,
        key_required,
        free_plan,
      }) => {
        const id = ProviderIdSchema.parse(provider);
        const saved = services.providers.get(id);
        const keyPresent = hasProviderKey(services, id);
        const enabled = saved?.enabled ?? keyPresent;
        const keyStatus: Provider['keyStatus'] = keyPresent
          ? (saved?.keyStatus ?? 'unchecked')
          : key_required === false && enabled
            ? 'not_applicable'
            : 'missing';
        const cooldown = services.cooldowns.get(id);
        const activeCooldown =
          cooldown && Date.parse(cooldown.until) > services.clock.now().getTime();
        return ProviderSchema.parse({
          id,
          name,
          tag,
          ...(free_plan === undefined
            ? {}
            : {
                freePlan: {
                  sourceUrl: free_plan.source_url,
                  models: free_plan.models,
                  ...(free_plan.excluded_models === undefined
                    ? {}
                    : { excludedModels: free_plan.excluded_models }),
                },
              }),
          billingEnabled: saved?.billingEnabled ?? false,
          kind: tag === 'subscription_cli' ? 'cli' : 'api',
          brand: null,
          keyStatus,
          enabled,
          health: activeCooldown
            ? 'cooldown'
            : saved?.health === 'cooldown'
              ? 'ok'
              : (saved?.health ?? 'unknown'),
          cooldownUntil: activeCooldown ? cooldown.until : null,
          cooldownProvenance:
            activeCooldown && routingSettings().cooldownReasons
              ? (cooldown.provenance ?? null)
              : null,
          dataUse: data_use,
          dataUseTraining:
            services.catalog.providers.find((item) => item.provider === provider)
              ?.data_use_training ?? null,
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
    ...[...new Set(oauthModelCatalog.map((model) => model.providerId))].map((id) => {
      const saved = services.providers.get(id);
      return ProviderSchema.parse({
        id,
        name:
          id === 'anthropic'
            ? 'Anthropic Claude Pro/Max'
            : id === 'openai-codex'
              ? 'OpenAI ChatGPT'
              : id === 'github-copilot'
                ? 'GitHub Copilot'
                : id === 'kimi-coding'
                  ? 'Kimi Code'
                  : id === 'meta'
                    ? 'Meta Muse'
                    : id === 'xai'
                      ? 'xAI Grok'
                      : id,
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
  const routingSettings = () => {
    const stored = services.settings.get('global');
    const routing =
      typeof stored === 'object' && stored !== null && 'routing' in stored
        ? stored.routing
        : undefined;
    return RoutingSettingsSchema.parse(routing ?? {});
  };
  const reliability = (): ReliabilityObservation[] =>
    z
      .array(
        z.object({ modelRef: z.string(), outcome: z.enum(['success', 'failure']), at: z.number() }),
      )
      .safeParse(services.settings.get('routing-reliability')).data ?? [];
  const usage: UsageSink = {
    record(raw) {
      services.quota.recordUsage(UsageRecordSchema.parse(raw));
      // QuotaEngine subscribers publish the authoritative quota.update summary.
    },
  };
  const providerFetch: typeof globalThis.fetch = async (input, init) =>
    globalThis.fetch(input, init);
  const observe = (observation: RawCallObservation) => {
    const turnId = traceContext?.turnId;
    if (turnId) {
      services.telemetry.turnUpdated(turnId, {
        ...(observation.statusCode !== null && observation.statusCode < 400
          ? { status: 'streaming' }
          : {}),
        http_status: observation.statusCode,
        routed_upstream_model: observation.upstreamModel ?? null,
        request_bytes: observation.requestBytes,
        rate_limit_headers: observation.rateLimitHeaders,
        latency_ms: Math.round(observation.latencyMs),
        error_kind: observation.errorKind,
        provider_key_id: selectedProviderKeys.get(traceContext.sessionId ?? '')?.keyId ?? null,
      });
      services.telemetry.log({
        id: newId('evt'),
        ts: services.clock.now().toISOString(),
        level: observation.statusCode !== null && observation.statusCode >= 400 ? 'warn' : 'info',
        source: 'provider',
        event: 'turn.request_sent',
        session_id: traceContext.sessionId,
        turn_id: turnId,
        trace_id: traceContext.traceId,
        span_id: traceContext.spanId,
        parent_span_id: traceContext.parentSpanId,
        device_id: traceContext.deviceId,
        app_version: traceContext.appVersion,
        data: {
          requested_model: observation.requestedModel ?? observation.modelRef,
          upstream_model: observation.upstreamModel ?? null,
          provider: observation.providerId,
          http_status: observation.statusCode,
          request_bytes: observation.requestBytes,
          latency_ms: Math.round(observation.latencyMs),
          rate_limit_headers: observation.rateLimitHeaders,
        },
      });
    }
    const providerId = ProviderIdSchema.parse(observation.providerId);
    const limits = services.catalog.providers.find((item) => item.provider === providerId);
    const model = services.catalog.models.find((item) => item.ref === observation.modelRef);
    const now = services.clock.now();
    services.telemetry.log({
      id: newId('evt'),
      ts: now.toISOString(),
      level: 'info',
      source: 'quota',
      event: 'quota.updated',
      session_id: traceContext?.sessionId,
      trace_id: traceContext?.traceId,
      data: {
        provider_id: providerId,
        model_ref: observation.modelRef,
        status_code: observation.statusCode,
        latency_ms: Math.round(observation.latencyMs),
      },
    });
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
    if (observation.statusCode === 429 || observation.statusCode === 503) {
      const retryAfter = observation.rateLimitHeaders['retry-after'];
      const retryTimestamp = retryAfterTimestamp(retryAfter, now);
      const selected = selectedProviderKeys.get(traceContext?.sessionId ?? '');
      const selectedEntry = selected
        ? services.providerKeyEntries.list(providerId).find((entry) => entry.id === selected.keyId)
        : undefined;
      if (selectedEntry && retryTimestamp) keyRetryAfter.set(selectedEntry.id, retryTimestamp);
      const cooldownKeyId =
        observation.statusCode === 503 ? providerId : (selectedEntry?.keyId ?? providerId);
      const cooldown = services.quota.noteFailure(
        providerId,
        observation.modelRef,
        cooldownKeyId,
        '429',
        retryTimestamp,
      );
      services.telemetry.log({
        id: newId('evt'),
        ts: now.toISOString(),
        level: 'warn',
        source: 'quota',
        event: 'quota.cooldown',
        session_id: traceContext?.sessionId,
        trace_id: traceContext?.traceId,
        data: {
          provider_id: providerId,
          model_ref: observation.modelRef,
          scope: observation.statusCode === 503 ? 'provider' : 'key_model',
          until: cooldown.cooldownUntil,
          status_code: observation.statusCode,
        },
      });
      if (observation.statusCode === 503 && cooldown.cooldownUntil)
        services.cooldowns.put({
          id: providerId,
          until: cooldown.cooldownUntil,
          ...(routingSettings().cooldownReasons
            ? {
                provenance: observation.rateLimitHeaders['retry-after']
                  ? 'authoritative'
                  : 'heuristic',
              }
            : {}),
        });
      const saved = services.providers.get(providerId);
      if (saved && observation.statusCode === 503)
        services.providers.put({
          ...saved,
          health: 'cooldown',
          cooldownUntil: cooldown.cooldownUntil ?? null,
        });
    } else if (observation.statusCode !== null && observation.statusCode < 400) {
      const selected = selectedProviderKeys.get(traceContext?.sessionId ?? '');
      const selectedEntry = selected
        ? services.providerKeyEntries.list(providerId).find((entry) => entry.id === selected.keyId)
        : undefined;
      services.quota.noteSuccess(
        providerId,
        observation.modelRef,
        selectedEntry?.keyId ?? providerId,
      );
      services.cooldowns.delete(providerId);
      const saved = services.providers.get(providerId);
      if (saved) {
        const verifiedModel =
          model ??
          services.models
            .list(providerId)
            .find((candidate) => candidate.ref === observation.modelRef);
        const availableModels = saved.availableModels ?? [];
        services.providers.put({
          ...saved,
          keyStatus: 'valid',
          health: 'ok',
          cooldownUntil: null,
          ...(verifiedModel
            ? {
                availableModels: [
                  ...availableModels.filter((candidate) => candidate.ref !== verifiedModel.ref),
                  verifiedModel,
                ],
                modelCount: new Set([
                  ...availableModels.map((candidate) => candidate.ref),
                  verifiedModel.ref,
                ]).size,
                modelsVerifiedAt: now.toISOString(),
                excludedModelRefs: (saved.excludedModelRefs ?? []).filter(
                  (ref) => ref !== verifiedModel.ref,
                ),
              }
            : {}),
        });
      }
    }
  };
  const gateway: ModelGateway = {
    providerAffinityKey(providerId, sessionId) {
      const selected = selectedProviderKeys.get(sessionId);
      return selected?.providerId === providerId ? selected.keyId : undefined;
    },
    providerKeyIds(providerId) {
      const entries = services.providerKeyEntries.list(providerId);
      return entries.length ? entries.map((entry) => entry.id) : [providerId];
    },
    unavailableProviderKeyIds(providerId, modelRef) {
      const now = services.clock.now().getTime();
      return services.providerKeyEntries.list(providerId).flatMap((entry) => {
        const entryCooldown = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : 0;
        const statusUnavailable =
          !entry.enabled ||
          entry.status === 'invalid' ||
          ((entry.status === 'rate_limited' || entry.status === 'disabled') && entryCooldown > now);
        const quotaUnavailable = Boolean(
          modelRef && services.quota.health(providerId, modelRef, entry.keyId).health !== 'ok',
        );
        return statusUnavailable || quotaUnavailable ? [entry.id] : [];
      });
    },
    async probeHeuristicCooldowns() {
      if (!routingSettings().cooldownReasons) return;
      const now = services.clock.now().getTime();
      for (const cooldown of services.cooldowns.list()) {
        if (
          !canProbeCooldown(
            {
              until: Date.parse(cooldown.until),
              provenance: cooldown.provenance ?? 'authoritative',
            },
            now,
          )
        )
          continue;
        const providerId = ProviderIdSchema.safeParse(cooldown.id);
        if (!providerId.success) continue;
        const key = await services.secrets.get(providerId.data);
        if (!key) continue;
        const baseUrl = providerBaseUrls[providerId.data];
        const result = await probeProvider(
          providerId.data,
          key,
          ...(baseUrl ? [{ baseUrl }] : []),
        ).catch(() => null);
        if (!result?.ok) continue;
        services.cooldowns.delete(providerId.data);
        const saved = services.providers.get(providerId.data);
        if (saved)
          services.providers.put({
            ...saved,
            health: 'ok',
            cooldownUntil: null,
            cooldownProvenance: null,
          });
      }
    },
    resolveCandidates(profile, stepKind, inputTokens = 1) {
      const configuredProviders = services.catalog.providers.filter(
        ({ provider, key_required }) => {
          const saved = services.providers.get(provider);
          const enabled = saved?.enabled ?? hasProviderKey(services, provider);
          return enabled && (hasProviderKey(services, provider) || key_required === false);
        },
      );
      const available = configuredProviders.flatMap(({ provider }) => {
        const saved = services.providers.get(provider);
        return services.models
          .list(provider)
          .filter((model) => !saved?.excludedModelRefs?.includes(model.ref));
      });
      const oauthRoutingEnabled =
        (services.settings.get('global') as { allowSubscriptionOAuthRouting?: boolean } | undefined)
          ?.allowSubscriptionOAuthRouting === true;
      const oauthModels = oauthRoutingEnabled
        ? oauthModelCatalog.filter((model) => {
            const saved = services.providers.get(model.providerId);
            return saved?.enabled && saved.keyStatus === 'valid';
          })
        : [];
      const candidates = [...available, ...oauthModels];
      const verifiedModelRefs = configuredProviders.flatMap(({ provider }) => {
        const saved = services.providers.get(provider);
        return saved?.modelsVerifiedAt && saved.availableModels
          ? saved.availableModels.map((model) => model.ref)
          : [];
      });
      const preferredModelRefs = configuredProviders.flatMap(({ provider, probe_models = [] }) => {
        const providerModels = available.filter((model) => model.providerId === provider);
        const refsById = new Map(
          providerModels.map((model) => [model.ref.slice(provider.length + 1), model.ref]),
        );
        const exactPreferences = probe_models.flatMap((id) => {
          const preferredId = provider === 'nvidia' ? id.replace(/^nvidia\//i, '') : id;
          const ref = refsById.get(preferredId);
          const model = providerModels.find((candidate) => candidate.ref === ref);
          return ref &&
            model &&
            modelSupportsTools(model) &&
            isPreferredToolModel(provider, preferredId)
            ? [ref]
            : [];
        });
        const providerDefaults = providerModels
          .filter(
            (model) =>
              modelSupportsTools(model) &&
              (isPreferredToolModel(provider, model.ref.slice(provider.length + 1)) ||
                model.capability?.toolCall == null ||
                (provider === 'openrouter' && model.free)),
          )
          .map((model) => model.ref);
        return [...new Set([...exactPreferences, ...providerDefaults])];
      });
      const baseCapacity = capacity();
      const tokensPerMinuteRemaining: Record<string, number | null> = {};
      const tokensPerMinuteLimit: Record<string, number | null> = {};
      for (const { provider, windows } of services.catalog.providers) {
        if (!configuredProviders.some((item) => item.provider === provider)) continue;
        const observed = services.quota.getWindows(provider);
        for (const definition of windows) {
          if (
            definition.metric !== 'tokens' ||
            definition.kind !== 'rolling' ||
            (definition.length ?? 0) > 60
          )
            continue;
          const windowId = `${provider}:${definition.scope}:${definition.model ?? '*'}:tokens:rolling`;
          const live = observed.find((item) => item.id === windowId);
          const limit = live?.limit ?? definition.limit;
          const remaining = live?.remaining ?? limit;
          const keys =
            definition.scope === 'model' && definition.model
              ? services.catalog.models
                  .filter(
                    (model) =>
                      model.providerId === provider &&
                      model.ref
                        .slice(provider.length + 1)
                        .toLowerCase()
                        .endsWith(definition.model?.toLowerCase() ?? ''),
                  )
                  .map((model) => model.ref)
              : [provider];
          for (const key of keys) {
            if (remaining !== null)
              tokensPerMinuteRemaining[key] = Math.min(
                tokensPerMinuteRemaining[key] ?? Number.POSITIVE_INFINITY,
                remaining,
              );
            if (limit !== null)
              tokensPerMinuteLimit[key] = Math.min(
                tokensPerMinuteLimit[key] ?? Number.POSITIVE_INFINITY,
                limit,
              );
          }
        }
      }
      const routingCapacity: CapacityView = {
        ...baseCapacity,
        tokensPerMinuteRemaining,
        tokensPerMinuteLimit,
      };
      const chain = chainForProfile(profile);
      const chainResult = resolveFallbackChain({
        chain,
        models: candidates,
        capacity: routingCapacity,
        profile,
        inputTokens,
        step: stepKind,
        verifiedModelRefs,
        avoidTrainingProviders: routingSettings().avoidTrainingProviders,
        trialOptInProviders: routingSettings().trialOptInProviders,
        textToolFallbackEnabled: routingSettings().textToolFallbackEnabled,
        now: services.clock.now().getTime(),
      });
      const chainRefs = new Set(chainResult.models.map((model) => model.ref));
      const ranked = scoreModels({
        models: candidates.filter(
          (model) =>
            !chainRefs.has(model.ref) &&
            (!chain.length || isStrictFallbackNameEligible(model, verifiedModelRefs)),
        ),
        providers: providers(),
        capacity: routingCapacity,
        profile,
        step: stepKind,
        estimate: { inputTokens, requiresTools: true },
        preferredModelRefs,
        verifiedModelRefs,
        routing: routingSettings(),
        trialOptInProviders: routingSettings().trialOptInProviders,
        textToolFallbackEnabled: routingSettings().textToolFallbackEnabled,
        reliability: reliability(),
        random: services.random,
      });
      const modelByRef = new Map(candidates.map((model) => [model.ref, model]));
      return [
        ...chainResult.models,
        ...ranked.flatMap(({ ref }) => {
          const model = modelByRef.get(ref);
          return model ? [model] : [];
        }),
      ];
    },
    recordHandoff(sessionId, reason) {
      services.handoffs.put({ id: newId('handoff'), sessionId, reason });
    },
    async streamStep(req, signal) {
      const providerId = req.model.providerId;
      if (oauthModelCatalog.some((model) => model.providerId === providerId))
        return await streamOAuthStep(services.secrets, { ...req, signal });
      const sessionId = traceContext?.sessionId ?? req.messages.at(-1)?.sessionId ?? '';
      const entries = services.providerKeyEntries.list(providerId);
      const stickyRoutes = z
        .record(
          z.string(),
          z.object({
            modelRef: z.string(),
            providerId: z.string().optional(),
            providerKeyId: z.string().optional(),
            expiresAt: z.number(),
          }),
        )
        .safeParse(services.settings.get('routing-sticky-sessions')).data;
      const stickyRoute = stickyRoutes?.[sessionId];
      const stickyKeyId =
        stickyRoute?.providerId === providerId &&
        stickyRoute.expiresAt > services.clock.now().getTime()
          ? stickyRoute.providerKeyId
          : undefined;
      let preferredKeyId = stickyKeyId;
      if (
        stickyKeyId &&
        !entries.some((entry) => entry.id === stickyKeyId) &&
        services.providerKeys.get(providerId)?.id === stickyKeyId
      )
        preferredKeyId = entries.find((entry) => entry.position === 0)?.id;
      const now = services.clock.now();
      const availableEntries = entries.filter(
        (entry) => services.quota.health(providerId, req.model.ref, entry.keyId).health === 'ok',
      );
      const selectedKey = providerKeyRotation.select(
        providerId,
        availableEntries.map((entry) => ({ ...entry, order: entry.position })),
        now,
        'round_robin',
        preferredKeyId,
      );
      if (selectedKey) selectedProviderKeys.set(sessionId, { providerId, keyId: selectedKey.id });
      const key = selectedKey
        ? await services.secrets.get(selectedKey.keyringRef)
        : entries.length === 0 && hasProviderKey(services, providerId)
          ? await services.secrets.get(
              services.providerKeys.get(providerId)?.keyringRef ?? providerId,
            )
          : undefined;
      if (!key && entries.length > 0)
        throw Object.assign(new Error(`All configured keys for ${providerId} are unavailable.`), {
          statusCode: 429,
        });
      if (key) apiKeys[providerId] = key;
      else Reflect.deleteProperty(apiKeys, providerId);
      const outputState = { started: false };
      const emitStep = (event: AgentEvent) => {
        if (event.type === 'session.delta' && event.text) outputState.started = true;
        emit(event);
      };
      const generator = createStepGenerator(
        {
          apiKeys,
          providerBaseUrls,
          providerFetch,
          emit: emitStep,
          onObservation: observe,
          providerOverrides: (model) =>
            resolveProviderRequestOverrides(
              model.providerId,
              routingSettings().providerOverrides[model.providerId],
            ),
        },
        req.model,
        sessionId,
      );
      try {
        const generated = await generator({
          ...req,
          modelHints: { ...req.modelHints, ...modelHintsFromRegistry(req.model) },
          signal,
        });
        if (selectedKey && selectedKey.status !== 'ok')
          services.providerKeyEntries.put({
            ...selectedKey,
            status: 'ok',
            lastError: null,
            cooldownUntil: null,
            updatedAt: services.clock.now().toISOString(),
          });
        if (selectedKey)
          services.providerKeyUsage.record(
            providerId,
            selectedKey.keyId,
            services.clock.now(),
            generated.inputTokens ?? 0,
            generated.outputTokens ?? 0,
          );
        return generated;
      } catch (error) {
        const statusCode = providerErrorStatus(error);
        const capacityError = isProviderCapacityError(error);
        if (selectedKey) {
          const retryAfter =
            providerErrorRetryAfter(error, services.clock.now()) ??
            keyRetryAfter.get(selectedKey.id);
          keyRetryAfter.delete(selectedKey.id);
          const keyStatusCode =
            capacityError && ![429, 503].includes(statusCode) ? 429 : statusCode;
          recordProviderKeyFailure(
            services,
            selectedKey,
            keyStatusCode,
            providerErrorMessageForRouting(error),
            retryAfter,
          );
          if (capacityError && ![429, 503].includes(statusCode))
            services.quota.noteFailure(
              providerId,
              req.model.ref,
              selectedKey.keyId,
              '429',
              retryAfter,
            );
        }
        if (
          selectedKey &&
          !outputState.started &&
          ([401, 402, 403, 429].includes(statusCode) || capacityError) &&
          hasUsableProviderKey(services, providerId)
        )
          return await gateway.streamStep(req, signal);
        const savedProvider = services.providers.get(providerId);
        const unsupportedFreeTier =
          providerId === 'opencode' &&
          providerErrorStatus(error) === 403 &&
          /free (?:models|tier).{0,60}(?:open.?code|zen)|only work inside open.?code/i.test(
            providerErrorMessageForRouting(error),
          );
        if (unsupportedFreeTier && savedProvider)
          services.providers.put({ ...savedProvider, freeTierUnsupported: true });
        if (capacityError && !selectedKey && ![429, 503].includes(statusCode)) {
          const cooldown = services.quota.noteFailure(providerId, req.model.ref, providerId, '429');
          services.telemetry.log({
            id: newId('evt'),
            ts: services.clock.now().toISOString(),
            level: 'warn',
            source: 'quota',
            event: 'quota.cooldown',
            session_id: traceContext?.sessionId,
            trace_id: traceContext?.traceId,
            data: {
              provider_id: providerId,
              model_ref: req.model.ref,
              until: cooldown.cooldownUntil,
              reason: 'provider capacity',
            },
          });
          if (cooldown.cooldownUntil)
            services.cooldowns.put({
              id: providerId,
              until: cooldown.cooldownUntil,
              ...(routingSettings().cooldownReasons ? { provenance: 'heuristic' } : {}),
            });
          const saved = services.providers.get(providerId);
          if (saved)
            services.providers.put({
              ...saved,
              health: 'cooldown',
              cooldownUntil: cooldown.cooldownUntil,
            });
        }
        if (isToolCapabilityError(error)) {
          const updatedModel = {
            ...req.model,
            toolCalling: false,
            ...(req.model.capability
              ? { capability: { ...req.model.capability, toolCall: false } }
              : {}),
          };
          const updatedAt = services.clock.now().toISOString();
          services.models.put(providerId, updatedModel, updatedAt);
          const provider = services.providers.get(providerId);
          if (provider?.availableModels) {
            const availableModels = provider.availableModels.map((model) =>
              model.ref === req.model.ref ? updatedModel : model,
            );
            services.providers.put({
              ...provider,
              availableModels,
              modelCount: availableModels.length,
              excludedModelRefs: [
                ...new Set([...(provider.excludedModelRefs ?? []), req.model.ref]),
              ],
            });
          } else if (provider) {
            services.providers.put({
              ...provider,
              excludedModelRefs: [
                ...new Set([...(provider.excludedModelRefs ?? []), req.model.ref]),
              ],
            });
          }
        }
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
              excludedModelRefs: [...new Set([...(saved.excludedModelRefs ?? []), req.model.ref])],
            });
          } else if (saved) {
            services.providers.put({
              ...saved,
              excludedModelRefs: [...new Set([...(saved.excludedModelRefs ?? []), req.model.ref])],
            });
          }
        }
        throw error;
      }
    },
  };
  return { gateway, usage, capacity, providers, apiKeys, providerFetch, observe };
}

export function modelHintsFromRegistry(model: Pick<ModelInfo, 'capability'>): Partial<ModelHints> {
  if (!model.capability) return {};
  return {
    toolProtocol: model.capability.toolProtocol,
    editFormat: model.capability.editFormat,
  };
}

function providerErrorStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const outer = error as { name?: unknown; cause?: unknown };
  const source =
    outer.name === 'AI_StreamProviderError' && outer.cause && typeof outer.cause === 'object'
      ? outer.cause
      : error;
  const candidate = source as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  return Number(candidate.statusCode ?? candidate.status ?? candidate.response?.status ?? 0);
}

function providerErrorRetryAfter(error: unknown, now: Date): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const outer = error as { name?: unknown; cause?: unknown };
  const source =
    outer.name === 'AI_StreamProviderError' && outer.cause && typeof outer.cause === 'object'
      ? outer.cause
      : error;
  const candidate = source as {
    response?: { headers?: Headers };
    responseHeaders?: Record<string, string>;
    headers?: Headers | Record<string, string>;
  };
  const headers = candidate.response?.headers ?? candidate.headers;
  const raw =
    (headers instanceof Headers ? headers.get('retry-after') : undefined) ??
    candidate.responseHeaders?.['retry-after'] ??
    candidate.responseHeaders?.['Retry-After'] ??
    (headers && !(headers instanceof Headers)
      ? (headers['retry-after'] ?? headers['Retry-After'])
      : undefined);
  if (!raw) return undefined;
  return retryAfterTimestamp(raw, now);
}

function retryAfterTimestamp(raw: string | undefined, now: Date): string | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  const until = Number.isFinite(seconds)
    ? now.getTime() + Math.max(0, seconds) * 1000
    : Date.parse(raw);
  return Number.isFinite(until) && until > now.getTime()
    ? new Date(until).toISOString()
    : undefined;
}

function providerErrorMessageForRouting(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  return typeof error.message === 'string' ? error.message : '';
}

function isProviderCapacityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    data?: { error?: { code?: unknown; type?: unknown; message?: unknown } };
    responseBody?: unknown;
  };
  let bodyError: { code?: string; type?: string; message?: string } | undefined;
  if (typeof candidate.responseBody === 'string') {
    try {
      const parsed: unknown = JSON.parse(candidate.responseBody);
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const errorBody = parsed.error;
        if (errorBody && typeof errorBody === 'object') {
          const errorRecord = errorBody as Record<string, unknown>;
          bodyError = {
            ...(typeof errorRecord.code === 'string' ? { code: errorRecord.code } : {}),
            ...(typeof errorRecord.type === 'string' ? { type: errorRecord.type } : {}),
            ...(typeof errorRecord.message === 'string' ? { message: errorRecord.message } : {}),
          };
        }
      }
    } catch {
      bodyError = undefined;
    }
  }
  const code = [candidate.code, candidate.data?.error?.code, candidate.data?.error?.type]
    .concat([bodyError?.code, bodyError?.type])
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const message = [candidate.message, candidate.data?.error?.message, bodyError?.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return (
    providerErrorStatus(error) === 429 ||
    providerErrorStatus(error) === 503 ||
    /RESOURCE_EXHAUSTED/i.test(code) ||
    candidate.name === 'ResourceExhausted' ||
    /resource_exhausted|capacity|overloaded|worker\b.{0,100}\blimit reached/i.test(message)
  );
}

function isToolCapabilityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
    responseBody?: unknown;
    data?: { error?: { message?: unknown } };
  };
  const status = Number(
    candidate.statusCode ?? candidate.status ?? candidate.response?.status ?? 0,
  );
  let message =
    typeof candidate.data?.error?.message === 'string'
      ? candidate.data.error.message
      : typeof candidate.message === 'string'
        ? candidate.message
        : '';
  if (typeof candidate.responseBody === 'string') {
    try {
      const body: unknown = JSON.parse(candidate.responseBody);
      if (
        body &&
        typeof body === 'object' &&
        'error' in body &&
        body.error &&
        typeof body.error === 'object' &&
        'message' in body.error &&
        typeof body.error.message === 'string'
      )
        message = body.error.message;
    } catch {
      // Keep the short provider message; never surface a raw response payload.
    }
  }
  return (
    status === 400 &&
    /function calling.{0,30}(?:not enabled|not supported)|does not support tools|tool use is not supported|tool_choice.{0,30}(?:not supported|unsupported|invalid)/i.test(
      message,
    )
  );
}

function isPreferredToolModel(providerId: string, modelId: string): boolean {
  if (providerId === 'gemini') return /^(?:gemini-3\.8-flash|gemini-flash-latest)$/i.test(modelId);
  if (providerId === 'groq') return /^(?:qwen\/qwen3\.8-27b|openai\/gpt-oss-120b)$/i.test(modelId);
  if (providerId === 'mistral') return /^(?:codestral-|devstral-|mistral-medium)/i.test(modelId);
  if (providerId === 'cerebras') return /^(?:gpt-oss-120b|qwen-3\.8-27b)$/i.test(modelId);
  if (providerId === 'sambanova')
    return /^(?:gpt-oss-120b|meta-llama-3\.3-70b-instruct)$/i.test(modelId);
  if (providerId === 'nvidia') return /^(?:nvidia\/)?nemotron-3-super-/i.test(modelId);
  return false;
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
