import { randomUUID } from 'node:crypto';
import {
  RoutingSettingsSchema,
  SettingsSchema,
  isOpenCodeAppModel,
  ProviderCheckResultSchema,
  type ProviderCheckProgress,
  type ProviderCheckResult,
  type ProviderCheckOptions,
} from '@ferry/shared';
import { calculateSpend, classifyProviderError, isFreeForRouting } from '@ferry/router';
import { streamProviderChat, resolveProviderRequestOverrides } from '@ferry/providers';
import type { FerryServices } from './services.js';
import { hasUsableProviderKey, permitsKeylessProvider } from './services.js';
import { withGatewayDeadlines } from './gateway-deadlines.js';
import { createSessionDependencies } from './session-deps.js';
import { reserveSpend } from './spending.js';
import { providerBaseUrl } from './provider-endpoints.js';

/** One shared check run per Core. Results contain synthetic-request metadata only. */
export function createProviderChecks(
  services: FerryServices,
  publish: (progress: ProviderCheckProgress) => void,
) {
  let current: ProviderCheckProgress = {
    id: 'previous',
    running: false,
    cancelled: false,
    results:
      ProviderCheckResultSchema.array().safeParse(services.settings.get('provider-check-results'))
        .data ?? [],
    error: null,
  };
  let controller = new AbortController();
  const isCancelled = (): boolean => controller.signal.aborted;
  let pending: Promise<void> | undefined;
  const emit = () => {
    publish(structuredClone(current));
  };
  const run = async (options: ProviderCheckOptions) => {
    const settings = services.settings.get('global') as { routing?: unknown } | undefined;
    const routing = RoutingSettingsSchema.parse(settings?.routing ?? {});
    const globalCaps = SettingsSchema.safeParse(settings).data?.paidCaps ?? {
      sessionUsd: null,
      dailyUsd: null,
      monthlyUsd: null,
    };
    const deps = createSessionDependencies(services, () => undefined);
    const targets = deps
      .providers()
      .filter(
        (provider) =>
          provider.enabled &&
          provider.keyStatus !== 'invalid' &&
          (!provider.cooldownUntil ||
            Date.parse(provider.cooldownUntil) <= services.clock.now().getTime()) &&
          !provider.id.startsWith('oauth-') &&
          provider.kind === 'api' &&
          hasUsableProviderKey(services, provider.id),
      )
      .flatMap((provider) => {
        const model = services.models
          .list(provider.id)
          .find(
            (model) =>
              !isOpenCodeAppModel(model) &&
              (options.approvedCostUsd === undefined
                ? isFreeForRouting(provider, model, routing.trialOptInProviders)
                : !isFreeForRouting(provider, model, routing.trialOptInProviders) &&
                  model.priceInPerM !== null &&
                  model.priceOutPerM !== null),
          );
        return model ? [{ provider, model }] : [];
      });
    if (!targets.length)
      current.error =
        options.approvedCostUsd === undefined
          ? 'No eligible connected free model to check. Connect a provider first.'
          : 'No connected paid API model with known pricing to check. Account checks use Gateway verification.';
    let index = 0;
    const worker = async () => {
      while (!isCancelled() && index < targets.length) {
        const target = targets[index++];
        if (!target) return;
        const { provider, model } = target;
        const started = Date.now();
        const timing: { first: number | null } = { first: null };
        const paid = options.approvedCostUsd !== undefined;
        let reservation: ReturnType<typeof reserveSpend> | undefined;
        let dispatched = false;
        const result: ProviderCheckResult = {
          reachability: 'unknown',
          authentication: 'unknown',
          paid,
          costUsd: null,
          providerId: provider.id,
          modelRef: model.ref,
          ok: false,
          at: services.clock.now().toISOString(),
          firstResponseMs: null,
          completionMs: null,
          sampleCount: 0,
          message: 'Not checked.',
          features:
            'Text generation tested; tools, structured output and multimodal compatibility require request-specific verification.',
        };
        try {
          const entries = services.providerKeyEntries.list(provider.id);
          const entry = entries.find(
            (entry) =>
              entry.enabled &&
              entry.status !== 'invalid' &&
              (!entry.cooldownUntil ||
                Date.parse(entry.cooldownUntil) <= services.clock.now().getTime()),
          );
          const ref = entry?.keyringRef ?? services.providerKeys.get(provider.id)?.keyringRef;
          const secret = ref ? await services.secrets.get(ref) : undefined;
          if (!secret && !permitsKeylessProvider(services, provider.id))
            throw new Error('Connect usable provider credentials.');
          controller.signal.throwIfAborted();
          const latest = services.providers.get(provider.id);
          if (
            latest?.enabled === false ||
            (!paid &&
              !isFreeForRouting({ ...provider, ...latest }, model, routing.trialOptInProviders))
          )
            throw new Error('Connection policy changed; free checks stopped.');
          const baseUrl = providerBaseUrl(services, provider.id);
          if (paid) {
            // All concurrent workers share one operation ceiling through atomic reservations.
            reservation = reserveSpend(services, {
              id: `check:${current.id}:${provider.id}`,
              profileId: 'provider-check',
              sessionId: current.id,
              amountUsd: calculateSpend({ inputTokens: 128, outputTokens: 32 }, model),
              profileCaps: {
                sessionUsd: options.approvedCostUsd ?? 0,
                dailyUsd: null,
                monthlyUsd: null,
              },
              globalCaps,
            });
          }
          controller.signal.throwIfAborted();
          dispatched = true;
          result.sampleCount = 1;
          const response = await withGatewayDeadlines(
            {
              signal: controller.signal,
              firstResponseMs: routing.firstTokenTimeoutSeconds * 1000,
              idleMs: 15000,
              overallMs: 30000,
            },
            (signal, progress) =>
              streamProviderChat({
                model: model.ref,
                modelInfo: model,
                apiKey: secret ?? '',
                messages: [{ role: 'user', content: 'Reply with Ready.' }],
                maxTokens: 32,
                signal,
                fetch: deps.providerFetch,
                ...(baseUrl ? { baseUrl } : {}),
                overrides: resolveProviderRequestOverrides(
                  provider.id,
                  routing.providerOverrides[provider.id],
                ),
                onObservation: deps.observe,
                onProgress: progress,
                onText: () => {
                  timing.first ??= Date.now() - started;
                },
              }),
          );
          const saved = services.providers.get(provider.id);
          if (
            providerBaseUrl(services, provider.id) !== baseUrl ||
            saved?.enabled === false ||
            (ref && (await services.secrets.get(ref)) !== secret)
          )
            throw new Error('Connection changed during the check. Check it again.');
          if (saved)
            services.providers.put({
              ...saved,
              modelsVerifiedAt: services.clock.now().toISOString(),
              availableModels: [
                ...(saved.availableModels ?? []).filter((item) => item.ref !== model.ref),
                {
                  ...model,
                  apiAccessVerified: true,
                  verified: true,
                  verifiedAt: services.clock.now().toISOString(),
                },
              ],
            });
          services.models.put(provider.id, {
            ...model,
            apiAccessVerified: true,
            verified: true,
            verifiedAt: services.clock.now().toISOString(),
          });
          result.ok = true;
          result.reachability = 'reachable';
          result.authentication = secret ? 'accepted' : 'not_required';
          const usageMissing =
            !Number.isFinite(response.inputTokens) ||
            !Number.isFinite(response.outputTokens) ||
            response.inputTokens + response.outputTokens === 0;
          result.costUsd = paid
            ? usageMissing
              ? (reservation?.estimatedUsd ?? 0)
              : calculateSpend(
                  {
                    inputTokens: response.inputTokens,
                    outputTokens: response.outputTokens,
                    cachedTokens: response.cachedTokens ?? 0,
                  },
                  model,
                )
            : 0;
          result.estimatedCost = paid && usageMissing;
          reservation?.settle(result.costUsd, result.estimatedCost, true);
          result.firstResponseMs = timing.first;
          result.completionMs = Date.now() - started;
          result.message = 'Reachable. One sample measures responsiveness, not coding quality.';
          services.quota.recordUsage({
            id: `check:${current.id}:${provider.id}`,
            providerId: provider.id,
            modelRef: model.ref,
            occurredAt: services.clock.now().toISOString(),
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            cachedTokens: response.cachedTokens ?? 0,
            costUsd: result.costUsd,
            status: 'success',
            latencyMs: result.completionMs,
          });
        } catch (error) {
          if (reservation) {
            if (dispatched) {
              reservation.settle();
              result.costUsd = reservation.estimatedUsd;
              result.estimatedCost = true;
            } else reservation.cancelBeforeDispatch();
          }
          const kind = classifyProviderError(
            error instanceof Error ? error : { message: 'Check failed' },
          ).family;
          result.reachability =
            timing.first !== null ? 'reachable' : kind === 'auth' ? 'reachable' : 'unknown';
          result.authentication = kind === 'auth' ? 'rejected' : 'unknown';
          result.message = isCancelled()
            ? 'Check cancelled.'
            : kind === 'auth'
              ? 'Credentials rejected. Reconnect this provider.'
              : 'Generation failed. Check provider credentials, quota, test budget and supported model access.';
          result.completionMs = dispatched ? Date.now() - started : null;
        }
        current.results.push(result);
        emit();
      }
    };
    try {
      await Promise.all([worker(), worker()]);
    } finally {
      current.running = false;
      services.settings.put('provider-check-results', current.results);
      emit();
    }
  };
  return {
    start(options: ProviderCheckOptions = {}) {
      if (current.running) return { id: current.id };
      current = { id: randomUUID(), running: true, cancelled: false, results: [], error: null };
      controller = new AbortController();
      emit();
      pending = run(options).catch(() => {
        current.running = false;
        current.error = 'Provider checks failed. Try again.';
        emit();
      });
      return { id: current.id };
    },
    progress(id?: string) {
      if (id !== undefined && id !== current.id)
        throw new Error('Provider check no longer available. Start a new check.');
      if (!current.running)
        current.results =
          ProviderCheckResultSchema.array().safeParse(
            services.settings.get('provider-check-results'),
          ).data ?? [];
      return structuredClone(current);
    },
    cancel(id: string) {
      if (id !== current.id) throw new Error('Unknown provider check.');
      current.cancelled = true;
      controller.abort(new Error('Provider checks cancelled.'));
      emit();
      return structuredClone(current);
    },
    async close() {
      controller.abort(new Error('Core stopping.'));
      await pending;
    },
  };
}
