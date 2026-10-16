import { providerBaseUrl } from './provider-endpoints.js';
import { zenModel, zenProvider } from './zen-cli.js';
import { isOpenCodeAppModel } from '@ferry/shared';
import {
  createStepGenerator,
  type AgentEvent,
  type AgentTool,
  type GeneratedStep,
  type ModelHints,
  type ReportedStepUsage,
  type StepGeneratorInput,
  type StepProducer,
} from '@ferry/agent';
import type { RawCallObservation } from '@ferry/providers';
import type { Message, MessagePart, TraceContext } from '@ferry/shared';
import type { CliCallerTool, CliConversationMessage } from '@ferry/delegate';
import { ProviderKeyRotation, resolveProviderRequestOverrides } from '@ferry/providers';
import {
  ProviderIdSchema,
  ModelRefSchema,
  oauthProviderId,
  providerDefinition,
  ProviderSchema,
  RoutingSettingsSchema,
  UsageRecordSchema,
  QuotaObservationSchema,
  newId,
  type GatewayRequestRecord,
  type ModelInfo,
  type ModelRef,
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
} from '@ferry/router';
import { oauthModelCatalog, streamOAuthStep } from '@ferry/oauth';
import {
  hasUsableProviderKey,
  recordProviderKeyFailure,
  permitsKeylessProvider,
  type FerryServices,
} from './services.js';
import { z } from 'zod';
import {
  classifyLedgerError,
  recordRequestFailure,
  markRecordedAttempt,
} from './request-failures.js';
import { getGatewayController } from './gateway.js';
import { observationsFromRateLimitHeaders } from '@ferry/quota';
import { getProviderHealth } from './provider-health.js';
import { cliProviderInfo, getCliBroker } from './cli-broker.js';

const providerKeyPresence = new WeakMap<FerryServices, Map<string, boolean>>();

export function invalidateSessionProviderKeyCache(
  services: FerryServices,
  providerId: string,
): void {
  providerKeyPresence.get(services)?.delete(providerId);
}

function hasProviderKey(services: FerryServices, providerId: string): boolean {
  if (permitsKeylessProvider(services, providerId)) return true;
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
  resolveCandidates(
    profile: Profile,
    stepKind: StepKind,
    inputTokens?: number,
    requiresTools?: boolean,
    /**
     * Installed-CLI funding surface whose opted-in/verified capacity joins the pool. Defaults to
     * `native` (the native API wrapper); the Gateway owner must pass `gateway` so Gateway Auto only
     * routes CLI capacity opted in for the gateway surface.
     */
    surface?: 'native' | 'gateway',
  ): ModelInfo[];
  recordHandoff(sessionId: string, reason: string): void;
  probeHeuristicCooldowns(): Promise<void>;
}
export interface UsageSink {
  record(record: UsageRecord): void;
}

export interface SessionDependencyContext {
  /** Active profile, used to apply `cliDefaults` to an installed-CLI dispatch. */
  profile?: Profile;
}

export function createSessionDependencies(
  services: FerryServices,
  emit: (event: AgentEvent) => void,
  traceContext?: TraceContext,
  context: SessionDependencyContext = {},
): {
  gateway: ModelGateway;
  usage: UsageSink;
  capacity: () => CapacityView;
  providers: () => Provider[];
  apiKeys: Record<string, string>;
  providerFetch: typeof globalThis.fetch;
  setProviderProgress: (progress: () => void) => void;
  providerHeaders: Record<string, Record<string, string>>;
  gatewayServedModel: () => string | null;
  revokeGatewayTokens: () => void;
  observe: (observation: RawCallObservation) => void;
  associateObservationKey: (providerId: string, keyId: string) => void;
} {
  const apiKeys: Record<string, string> = {};
  const health = getProviderHealth(services);
  const providerHeaders: Record<string, Record<string, string>> = {};
  let lastGatewayServedModel: string | null = null;
  // The exact API quota event id the Gateway already recorded for the generation in flight. Cleared
  // before every dispatch so a cancelled/later step can never re-record another step's event.
  let pendingUpstreamUsageId: string | null = null;
  let gatewayToken: string | undefined;
  const providerKeyRotation = new ProviderKeyRotation();
  const selectedProviderKeys = new Map<string, { providerId: string; keyId: string }>();
  const keyRetryAfter = new Map<string, string>();
  const providerBaseUrls = Object.fromEntries(
    services.catalog.providers.flatMap(({ provider }) => {
      const baseUrl = providerBaseUrl(services, provider);
      return baseUrl ? [[provider, baseUrl]] : [];
    }),
  );
  const providers = (): Provider[] => [
    ...services.catalog.providers
      .map(
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
          const enabled = saved?.enabled ?? (keyPresent || key_required === false);
          const keyStatus: Provider['keyStatus'] =
            permitsKeylessProvider(services, id) &&
            !services.providerKeys.get(id) &&
            !services.providerKeyEntries.list(id).length
              ? 'not_applicable'
              : keyPresent
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
      )
      .map((provider) => zenProvider(services, provider)),
    ...[...new Set(oauthModelCatalog.map((model) => model.providerId))].map((id) => {
      const saved = services.providers.get(id);
      return ProviderSchema.parse({
        id,
        name:
          oauthProviderId(id) === 'anthropic'
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
    // Opted-in/verified installed-CLI connections are first-class providers in the routing capacity
    // view, so a direct CLI selection resolves its `subscription_cli` lane instead of falling back to
    // the unknown-price metered path. Un-opted-in CLI kinds stay invisible here.
    ...getCliBroker(services, () => undefined)
      .connections()
      .filter(
        (connection) =>
          connection.surfaces.native ||
          connection.surfaces.gateway ||
          connection.verify.state === 'verified',
      )
      .map((connection) => cliProviderInfo(connection)),
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
      const parsed = UsageRecordSchema.parse(raw);
      if (pendingUpstreamUsageId === null) {
        services.quota.recordUsage(parsed);
        return;
      }
      // A native-through-Gateway API generation was already charged and recorded once by the Gateway
      // (same event id). Re-record that EXACT id with this conversation's session/actual-producer
      // attribution so the global provider event stays a single row while the conversation records its
      // own event.
      const upstreamUsageId = pendingUpstreamUsageId;
      pendingUpstreamUsageId = null;
      const existing = services.quota.getUsage(upstreamUsageId);
      // The Gateway's record is the sole authority for cost/plan/headers. Drop the conversation's
      // recomputed cost, plan and cost-estimate headers BEFORE carrying over the retained values, so a
      // pruned/missing original leaves them absent/unknown rather than inheriting an invented estimate.
      const {
        costUsd: _inventedCost,
        planUnits: _inventedPlan,
        headers: _inventedHeaders,
        ...rest
      } = parsed;
      services.quota.recordUsage(
        UsageRecordSchema.parse({
          ...rest,
          id: upstreamUsageId,
          ...(existing?.costUsd === undefined ? {} : { costUsd: existing.costUsd }),
          ...(existing?.planUnits === undefined ? {} : { planUnits: existing.planUnits }),
          ...(existing?.headers === undefined ? {} : { headers: existing.headers }),
        }),
      );
      // QuotaEngine subscribers publish the authoritative quota.update summary.
    },
  };
  // Installed-CLI generations never travel through this API-shaped fetch: they dispatch through the
  // shared broker (see `runNativeCliStep`/the legacy alias entry below). Only standard API traffic
  // reaches it, so there is no synthetic CLI interception left to keep in sync with the broker.
  const providerFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const requestUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (requestUrl.includes('/v1/chat/completions'))
      lastGatewayServedModel = response.headers.get('x-ferry-served-model');
    return response;
  };

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
    for (const record of observationsFromRateLimitHeaders(observation, limits?.windows ?? [], now))
      services.quota.observe(QuotaObservationSchema.parse(record));
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
      if (permitsKeylessProvider(services, providerId)) return [providerId];
      const entries = services.providerKeyEntries.list(providerId);
      return entries.length ? entries.map((entry) => entry.id) : [providerId];
    },
    unavailableProviderKeyIds(providerId, modelRef) {
      if (permitsKeylessProvider(services, providerId))
        return health.tracker.available(providerId, modelRef, providerId) ? [] : [providerId];
      const now = services.clock.now().getTime();
      const entries = services.providerKeyEntries.list(providerId);
      if (!entries.length && !health.tracker.available(providerId, modelRef, providerId))
        return [providerId];
      return entries.flatMap((entry) => {
        const entryCooldown = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : 0;
        const statusUnavailable =
          !entry.enabled ||
          entry.status === 'invalid' ||
          ((entry.status === 'rate_limited' || entry.status === 'disabled') && entryCooldown > now);
        const quotaUnavailable = Boolean(
          modelRef && services.quota.health(providerId, modelRef, entry.keyId).health !== 'ok',
        );
        return statusUnavailable ||
          quotaUnavailable ||
          !health.tracker.available(providerId, modelRef, entry.id)
          ? [entry.id]
          : [];
      });
    },
    async probeHeuristicCooldowns() {
      await health.recover();
    },
    resolveCandidates(
      profile,
      stepKind,
      inputTokens = 1,
      requiresTools = true,
      surface = 'native',
    ) {
      const configuredProviders = services.catalog.providers.filter(
        ({ provider, key_required }) => {
          const saved = services.providers.get(provider);
          const definition = providerDefinition(provider);
          if (
            definition?.releaseState === 'Coming soon' ||
            (definition?.releaseState === 'Beta' && saved?.enabled !== true)
          )
            return false;
          const enabled = saved?.enabled ?? hasProviderKey(services, provider);
          const entries = services.providerKeyEntries.list(provider);
          const availableKey =
            hasUsableProviderKey(services, provider) &&
            (permitsKeylessProvider(services, provider) || entries.length === 0
              ? health.tracker.available(provider, undefined, provider)
              : entries.some(
                  (entry) =>
                    health.tracker.available(provider, undefined, entry.id) &&
                    entry.enabled &&
                    entry.status !== 'invalid' &&
                    (!entry.cooldownUntil ||
                      Date.parse(entry.cooldownUntil) <= services.clock.now().getTime()),
                ));
          return (
            enabled &&
            health.tracker.available(provider) &&
            (availableKey || key_required === false)
          );
        },
      );
      const available = configuredProviders.flatMap(({ provider }) => {
        const saved = services.providers.get(provider);
        return services.models
          .list(provider)
          .map((model) => zenModel(services, model))
          .filter((model) => !isOpenCodeAppModel(model))
          .filter(
            (model) =>
              !saved?.excludedModelRefs?.includes(model.ref) &&
              health.tracker.available(provider, model.ref),
          );
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
      // Installed-CLI capacity that is genuinely fundable for this profile joins the Auto candidate
      // pool. `eligibleModels` already applies the exact-model verification receipt, effective
      // option/capability/tool/context fit, surface opt-in and funding policy. A Long Context step is
      // never satisfied by the explicit unknown-capacity policy placeholder: only a CLI route that
      // actually reported a context window competes for it.
      const cliEligible = getCliBroker(services, () => undefined)
        .eligibleModels({
          surface,
          profile,
          requiresTools,
          inputTokens,
        })
        .filter((model) => stepKind !== 'long_context' || model.capacityKnown === true);
      // Only genuinely free CLI capacity joins the primary (free) ranking, where it competes with
      // free API routes under the premade profile chain, preferences, quality and long-context rules.
      // Included-subscription capacity is ranked in its own band below and appended strictly after
      // every free route, so Auto can never prefer Included simply because it came from the CLI pool.
      const freeCli = cliEligible.filter((model) => model.free);
      const includedCli = cliEligible.filter((model) => !model.free);
      const candidates = [...available, ...oauthModels, ...freeCli];
      const verifiedModelRefs = [
        ...configuredProviders.flatMap(({ provider }) => {
          const saved = services.providers.get(provider);
          return saved?.modelsVerifiedAt && saved.availableModels
            ? saved.availableModels.map((model) => model.ref)
            : [];
        }),
        ...cliEligible.map((model) => model.ref),
      ];
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
        requiresTools,
        verifiedModelRefs,
        avoidTrainingProviders: routingSettings().avoidTrainingProviders,
        trialOptInProviders: routingSettings().trialOptInProviders,
        textToolFallbackEnabled: routingSettings().textToolFallbackEnabled,
        routing: routingSettings(),
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
        estimate: { inputTokens, requiresTools },
        preferredModelRefs,
        verifiedModelRefs,
        routing: routingSettings(),
        trialOptInProviders: routingSettings().trialOptInProviders,
        textToolFallbackEnabled: routingSettings().textToolFallbackEnabled,
        reliability: reliability(),
        codingObservations: codingObservations(services),
        stats: modelRoutingStats(services),
        random: services.random,
      });
      const modelByRef = new Map(candidates.map((model) => [model.ref, model]));
      const ordered = [
        ...chainResult.models,
        ...ranked.flatMap(({ ref }) => {
          const model = modelByRef.get(ref);
          return model ? [model] : [];
        }),
      ];
      if (profile.routingObjective === 'balanced' && ['edit', 'review'].includes(stepKind)) {
        const observations = codingObservations(services);
        const now = services.clock.now().getTime();
        ordered.sort(
          (a, b) =>
            codingQuality(observations, b.ref, now).score -
            codingQuality(observations, a.ref, now).score,
        );
        if (profile.provenance?.kind === 'provider-check') {
          const scores = new Map(
            scoreModels({
              models: ordered,
              providers: providers(),
              capacity: routingCapacity,
              profile,
              step: stepKind,
              estimate: { inputTokens, requiresTools },
              codingObservations: observations,
              routing: routingSettings(),
              verifiedModelRefs,
              stats: modelRoutingStats(services),
            }).map((candidate) => [candidate.ref, candidate.score]),
          );
          ordered.sort(
            (a, b) => (scores.get(b.ref) ?? -Infinity) - (scores.get(a.ref) ?? -Infinity),
          );
        }
      }
      // Included-subscription capacity is ranked in its own band (quality/long-context/tier rules
      // still apply within it) and appended strictly after every free API/CLI route. This is what
      // keeps global free-first ordering intact: an Included CLI route can never jump ahead of an
      // eligible free API provider merely because it arrived through the CLI pool.
      let includedOrdered: ModelInfo[] = [];
      if (includedCli.length > 0) {
        const includedByRef = new Map(includedCli.map((model) => [model.ref, model]));
        includedOrdered = scoreModels({
          models: includedCli,
          providers: providers(),
          capacity: routingCapacity,
          profile,
          step: stepKind,
          estimate: { inputTokens, requiresTools },
          preferredModelRefs,
          verifiedModelRefs,
          routing: routingSettings(),
          trialOptInProviders: routingSettings().trialOptInProviders,
          textToolFallbackEnabled: routingSettings().textToolFallbackEnabled,
          reliability: reliability(),
          codingObservations: codingObservations(services),
          stats: modelRoutingStats(services),
          random: services.random,
          allowIncludedSubscription: true,
        }).flatMap(({ ref }) => {
          const model = includedByRef.get(ref);
          return model ? [model] : [];
        });
      }
      return [...ordered, ...includedOrdered];
    },
    recordHandoff(sessionId, reason) {
      services.handoffs.put({ id: newId('handoff'), sessionId, reason });
    },
    async streamStep(req, signal) {
      const providerId = req.model.providerId;
      // Every step starts with no pending correlation, whatever branch it takes: a completed Gateway
      // generation whose usage consumer never ran can never lend its API event id to a later direct
      // (or Gateway) generation.
      pendingUpstreamUsageId = null;
      // A discovered installed-CLI model dispatches through the shared Core broker on the native
      // surface. Its original system/messages/tools/delta/progress/signal are preserved verbatim.
      if (req.model.cliConnectionId) return await runNativeCliStep(services, req, context.profile);
      // Legacy Zen alias entry: an old persisted `opencode/<id>` free-model ref resolves to the
      // discovered canonical `opencode-cli/opencode/<id>` and dispatches through the same shared
      // broker path. When no canonical model is discovered the ref is left to the standard API path;
      // no model is substituted.
      if (providerId === 'opencode' && req.model.free) {
        const alias = getCliBroker(services, () => undefined).model(req.model.ref);
        if (alias && alias.model.ref !== req.model.ref)
          return await runNativeCliStep(services, req, context.profile);
      }
      if (services.providers.get(providerId)?.enabled === false)
        throw Object.assign(
          new Error(`${providerId} is disabled or paused. Choose another provider or resume it.`),
          { statusCode: 429 },
        );
      if (providerId === 'gateway' && req.model.gateway) {
        const controller = getGatewayController(services);
        const status = controller?.status;
        if (!controller || !status?.running || status.port === null)
          throw Object.assign(
            new Error('Start the local Gateway before sending through this key.'),
            {
              code: 'gateway_not_running',
              kind: 'gateway_not_running',
            },
          );
        const key = controller.key(req.model.gateway.keyId);
        if (!key) throw new Error(`Unknown or revoked Gateway key: ${req.model.gateway.keyId}`);
        gatewayToken ??= controller.issueInternalToken(key.id);
        apiKeys.gateway = gatewayToken;
        providerBaseUrls.gateway = `http://127.0.0.1:${String(status.port)}/v1`;
        providerHeaders.gateway = { 'x-ferry-internal-token': gatewayToken };
        const sessionId = traceContext?.sessionId ?? '';
        // Per-generation evidence: the Gateway mints a fresh `x-ferry-trace-id` for exactly this one
        // internal request. Capture it from our own transport response (never an upstream header) so
        // the recorded completed outcome can be correlated by exact trace id + key id after the stream
        // finishes. Scoping the capture to this generation means an interleaved key or a cancelled
        // turn can never reuse another generation's evidence.
        const evidence: { traceId: string | null } = { traceId: null };
        const gatewayFetch: typeof globalThis.fetch = async (input, init) => {
          const response = await providerFetch(input, init);
          const requestUrl =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (requestUrl.includes('/v1/chat/completions')) {
            const traceId = response.headers.get('x-ferry-trace-id');
            if (traceId) evidence.traceId = traceId;
          }
          return response;
        };
        const generator = createStepGenerator(
          {
            apiKeys,
            providerBaseUrls,
            providerHeaders,
            providerFetch: gatewayFetch,
            emit,
            onObservation: observe,
          },
          req.model,
          sessionId,
        );
        const generated = await generator({ ...req, signal });
        const attribution = gatewayStepAttribution(
          controller.requests(),
          key.id,
          evidence.traceId,
          req.model.ref,
        );
        // Retain the exact API event id (if any) only for the usage record the agent loop is about to
        // emit for THIS step; it is consumed once and never reused.
        pendingUpstreamUsageId = attribution.upstreamUsageId;
        const { upstreamUsageId: _upstreamUsageId, ...step } = attribution;
        return { ...generated, ...step };
      }
      if (oauthModelCatalog.some((model) => model.providerId === providerId))
        return await streamOAuthStep(services.secrets, { ...req, signal });
      const sessionId = traceContext?.sessionId ?? req.messages.at(-1)?.sessionId ?? '';
      if (!health.tracker.available(providerId, req.model.ref))
        throw Object.assign(
          new Error(`Provider or model is temporarily unavailable: ${req.model.ref}`),
          { statusCode: 503 },
        );
      // Installed-CLI generations are dispatched above; only standard API credentials are read here.
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
        (entry) =>
          services.quota.health(providerId, req.model.ref, entry.keyId).health === 'ok' &&
          health.tracker.available(providerId, req.model.ref, entry.id),
      );
      const selectedKey = providerKeyRotation.select(
        providerId,
        availableEntries.map((entry) => ({ ...entry, order: entry.position })),
        now,
        'round_robin',
        preferredKeyId,
      );
      if (selectedKey) selectedProviderKeys.set(sessionId, { providerId, keyId: selectedKey.id });
      else selectedProviderKeys.delete(sessionId);
      const legacyKeyRef = services.providerKeys.get(providerId)?.keyringRef;
      const key = selectedKey
        ? await services.secrets.get(selectedKey.keyringRef)
        : entries.length === 0 && legacyKeyRef
          ? await services.secrets.get(legacyKeyRef)
          : undefined;
      if (!key && entries.length > 0 && !permitsKeylessProvider(services, providerId))
        throw Object.assign(new Error(`All configured keys for ${providerId} are unavailable.`), {
          statusCode: 429,
        });
      if (key) apiKeys[providerId] = key;
      else Reflect.deleteProperty(apiKeys, providerId);
      if (providerId === 'opencode') {
        const base = providerBaseUrl(services, providerId);
        if (base) providerBaseUrls[providerId] = base;
        else Reflect.deleteProperty(providerBaseUrls, providerId);
      }
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
        const startedAt = services.clock.now().getTime();
        const generated = await generator({
          ...req,
          modelHints: { ...req.modelHints, ...modelHintsFromRegistry(req.model) },
          signal,
        });
        health.record({
          providerId,
          modelRef: req.model.ref,
          keyId: selectedKey?.id ?? providerId,
          success: true,
          latencyMs: services.clock.now().getTime() - startedAt,
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
        if (!signal.aborted)
          health.record({
            providerId,
            modelRef: req.model.ref,
            keyId: selectedKey?.id ?? providerId,
            success: false,
            status: statusCode,
            message: providerErrorMessageForRouting(error),
            retryAfter:
              providerErrorRetryAfter(error, services.clock.now()) ??
              keyRetryAfter.get(selectedKey?.id ?? ''),
          });
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
        ) {
          recordRequestFailure(services, {
            ...classifyLedgerError(error),
            providerId,
            modelRef: req.model.ref,
            requestId: req.requestId ?? newId('request'),
            sessionId,
            keyId: selectedKey.id,
            source: 'agent',
          });
          if (services.providers.get(providerId)?.pausedReason) {
            markRecordedAttempt(error, req.requestId ?? '');
            throw error;
          }
          return await gateway.streamStep(req, signal);
        }
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
  return {
    setProviderProgress() {
      // Installed-CLI progress and queue waits are reported by the shared broker directly; the
      // standard API step generator has no progress hook, so this compatibility seam is inert.
    },
    gateway,
    usage,
    capacity,
    providers,
    apiKeys,
    providerFetch,
    providerHeaders,
    gatewayServedModel: () => lastGatewayServedModel,
    revokeGatewayTokens() {
      if (gatewayToken) getGatewayController(services)?.revokeInternalToken(gatewayToken);
      gatewayToken = undefined;
      Reflect.deleteProperty(apiKeys, 'gateway');
      Reflect.deleteProperty(providerHeaders, 'gateway');
    },
    observe,
    associateObservationKey(providerId, keyId) {
      selectedProviderKeys.set(traceContext?.sessionId ?? '', { providerId, keyId });
    },
  };
}

/**
 * Encode the agent's own system/messages into the caller conversation the CLI transports accept,
 * preserving roles, real tool-call ids and real tool results. Ferry never invents a tool result.
 */
export function encodeCliConversation(
  system: string,
  messages: readonly Message[],
): CliConversationMessage[] {
  const conversation: CliConversationMessage[] = [];
  if (system.trim()) conversation.push({ role: 'system', content: system });
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.parts
        .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (text) conversation.push({ role: 'user', content: text });
      continue;
    }
    const text = message.parts
      .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const calls = message.parts.filter(
      (part): part is Extract<MessagePart, { type: 'tool_call' }> => part.type === 'tool_call',
    );
    if (text || calls.length)
      conversation.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => ({
                id: call.toolCallId ?? call.id,
                type: 'function' as const,
                function: { name: call.tool, arguments: JSON.stringify(call.args) },
              })),
            }
          : {}),
      });
    for (const call of calls) {
      if (call.output)
        conversation.push({
          role: 'tool',
          content: call.output.text,
          tool_call_id: call.toolCallId ?? call.id,
        });
    }
  }
  return conversation;
}

function schemaToParameters(schema: AgentTool['schema']): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema);
    return typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

/** Convert the agent's tool registry entries into caller tools the CLI transports advertise. */
export function encodeCliTools(tools: readonly AgentTool[]): CliCallerTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.title ? { description: tool.title } : {}),
    parameters: schemaToParameters(tool.schema),
  }));
}

function estimateCliInputTokens(
  system: string,
  messages: readonly CliConversationMessage[],
  tools: readonly CliCallerTool[],
): number {
  const bytes =
    Buffer.byteLength(system, 'utf8') +
    Buffer.byteLength(JSON.stringify(messages), 'utf8') +
    Buffer.byteLength(JSON.stringify(tools), 'utf8');
  return Math.ceil(bytes / 4);
}

/**
 * Native-surface installed-CLI dispatch: resolve the cached CLI model/provider, apply conversation
 * and profile option defaults over the connection/model defaults, and run exactly one bounded turn
 * through the broker. Text streams to the caller's `onDelta`; tool calls are returned to the agent
 * loop for real execution and approval (the adapter never executes or approves a native tool).
 */
/**
 * An installed-CLI route is text-only. If any durable tool result carries image content (e.g. a
 * screenshot), the encoder would drop it and the model would answer as if it had seen the image.
 * Reject explicitly before dispatch instead of silently discarding the attachment.
 */
export function unsupportedCliImageMessage(messages: readonly Message[]): string | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_call' && part.output?.images && part.output.images.length > 0)
        return `A tool result for "${part.tool}" contains image content the installed-CLI route cannot send. No image was forwarded; retry without the screenshot or pick a vision-capable API model.`;
    }
  }
  return null;
}

async function runNativeCliStep(
  services: FerryServices,
  req: StepGeneratorInput,
  profile: Profile | undefined,
): Promise<GeneratedStep> {
  const imagesUnsupported = unsupportedCliImageMessage(req.messages);
  if (imagesUnsupported)
    throw Object.assign(new Error(imagesUnsupported), { code: 'unsupported_capability' });
  const modelRef = req.model.ref;
  const session = services.sessions.get(req.messages.at(-1)?.sessionId ?? '');
  const conversationOverride = session?.cliOptions?.[modelRef];
  const profileDefault = profile?.cliDefaults?.[modelRef];
  const messages = encodeCliConversation(req.system, req.messages);
  const tools = encodeCliTools(req.tools);
  const broker = getCliBroker(services, () => undefined);
  const dispatch = await broker.dispatch({
    surface: 'native',
    modelRef,
    messages,
    tools,
    signal: req.signal,
    ...(req.onProgress ? { onProgress: req.onProgress } : {}),
    onText: (text) => {
      req.onDelta(text);
    },
    ...(conversationOverride ? { optionOverride: conversationOverride } : {}),
    ...(profileDefault ? { profileCliDefault: profileDefault } : {}),
    inputTokens: estimateCliInputTokens(req.system, messages, tools),
  });
  const { result, connection, model, accountKey } = dispatch;
  const reportedUsage: ReportedStepUsage = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedTokens: result.usage.cachedTokens,
    reasoningTokens: result.usage.reasoningTokens,
  };
  // Preserve the producer captured by dispatch, including its original requested alias. Looking up
  // the connection after generation would attribute the reply to an account that may have changed.
  const producer: StepProducer = {
    modelRef: model.ref,
    providerId: ProviderIdSchema.parse(model.providerId),
    connectionId: connection.kind,
    accountKey,
    requestedModelRef: modelRef,
  };
  const step: GeneratedStep = {
    ...(result.text ? { text: result.text } : {}),
    ...(result.toolCalls.length
      ? {
          toolCalls: result.toolCalls.map((call) => ({
            id: call.id,
            toolCallId: call.id,
            name: call.name,
            input: call.arguments,
          })),
        }
      : {}),
    responseModel: result.responseModel,
    finishReason: result.toolCalls.length ? 'tool-calls' : 'stop',
    reportedUsage,
    producer,
  };
  return step;
}

/**
 * Pure half of Gateway step attribution: given the bounded `requests()` snapshot and this
 * generation's exact trace id + key id, derive the actual producer, authoritative reported usage, and
 * the exact API quota event id the Gateway already recorded (if any).
 *
 * Correlation is by the exact trace id the Gateway minted for this generation's request plus the key
 * id. When no completed outcome is retained (older record, mismatch, out of retention, or a
 * non-completed outcome), the producer is absent (honest unknown) and every usage dimension stays
 * `null` rather than being guessed from the standard-API SDK's parsed stream.
 *
 * An outcome that explicitly reports no usage (`usageReported === false`) contributes no reported
 * tokens: legacy/coalesced API zeros are not real reported usage and stay `null`. A real reported zero
 * (a CLI route with `usageReported === true`) is preserved as `0`.
 */
export function gatewayStepAttribution(
  requests: readonly GatewayRequestRecord[],
  keyId: string,
  traceId: string | null,
  requestedModelRef: ModelRef,
): { producer?: StepProducer; reportedUsage: ReportedStepUsage; upstreamUsageId: string | null } {
  const record = traceId
    ? requests.find((entry) => entry.traceId === traceId && entry.keyId === keyId)
    : undefined;
  const completed = record?.outcome === 'completed' ? record : undefined;
  const servedModel = ModelRefSchema.safeParse(
    completed ? (completed.servedModel ?? completed.modelRef) : null,
  );
  const servedProviderId = ProviderIdSchema.safeParse(completed?.servedProviderId);
  const producer: StepProducer | undefined =
    completed && servedModel.success && servedProviderId.success
      ? {
          modelRef: servedModel.data,
          providerId: servedProviderId.data,
          connectionId: completed.servedConnectionId ?? null,
          accountKey: completed.servedAccountKey ?? null,
          requestedModelRef,
        }
      : undefined;
  // Never surface an explicit "not reported" outcome's coalesced zeros as real tokens.
  const reported = completed?.usageReported === false ? undefined : completed?.reportedUsage;
  const reportedUsage: ReportedStepUsage = {
    inputTokens: reported?.inputTokens ?? null,
    outputTokens: reported?.outputTokens ?? null,
    cachedTokens: reported?.cachedTokens ?? null,
    reasoningTokens: reported?.reasoningTokens ?? null,
  };
  const upstreamUsageId = completed?.upstreamUsageId ?? null;
  return { ...(producer ? { producer } : {}), reportedUsage, upstreamUsageId };
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
  const status = providerErrorStatus(error);
  const message = providerErrorMessageForRouting(error);
  return (
    status === 404 ||
    status === 410 ||
    (status === 400 && /model.{0,60}not supported/i.test(message)) ||
    /model_not_found|not found for account|end of life|no longer available/i.test(message)
  );
}
import { codingObservations } from './coding-quality.js';
import { codingQuality } from '@ferry/router';
import { modelRoutingStats } from './model-routing-stats.js';
