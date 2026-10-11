import { randomUUID } from 'node:crypto';
import {
  RoutingSettingsSchema,
  isOpenCodeAppModel,
  ProviderCheckResultSchema,
  type ProviderCheckProgress,
  type ProviderCheckResult,
} from '@ferry/shared';
import { isFreeForRouting } from '@ferry/router';
import { streamProviderChat, resolveProviderRequestOverrides } from '@ferry/providers';
import type { FerryServices } from './services.js';
import { hasUsableProviderKey, permitsKeylessProvider } from './services.js';
import { withGatewayDeadlines } from './gateway-deadlines.js';
import { createSessionDependencies } from './session-deps.js';

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
  const run = async () => {
    const settings = services.settings.get('global') as { routing?: unknown } | undefined;
    const routing = RoutingSettingsSchema.parse(settings?.routing ?? {});
    const deps = createSessionDependencies(services, () => undefined);
    const targets = deps
      .providers()
      .filter(
        (provider) =>
          provider.enabled &&
          provider.health !== 'down' &&
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
              model.toolCalling &&
              isFreeForRouting(provider, model, routing.trialOptInProviders),
          );
        return model ? [{ provider, model }] : [];
      });
    if (!targets.length)
      current.error = 'No eligible connected free model to check. Connect a provider first.';
    let index = 0;
    const worker = async () => {
      while (!isCancelled() && index < targets.length) {
        const target = targets[index++];
        if (!target) return;
        const { provider, model } = target;
        const started = Date.now();
        const timing: { first: number | null } = { first: null };
        const result: ProviderCheckResult = {
          providerId: provider.id,
          modelRef: model.ref,
          ok: false,
          at: services.clock.now().toISOString(),
          firstResponseMs: null,
          completionMs: null,
          sampleCount: 1,
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
            !isFreeForRouting({ ...provider, ...latest }, model, routing.trialOptInProviders)
          )
            throw new Error('Connection policy changed; free checks stopped.');
          const envName = `FERRY_PROVIDER_BASE_URL_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
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
                ...(services.env[envName] ? { baseUrl: services.env[envName] } : {}),
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
          if (saved)
            services.providers.put({
              ...saved,
              modelsVerifiedAt: services.clock.now().toISOString(),
              availableModels: [
                ...(saved.availableModels ?? []).filter((item) => item.ref !== model.ref),
                { ...model, verified: true, verifiedAt: services.clock.now().toISOString() },
              ],
            });
          result.ok = true;
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
            costUsd: 0,
            status: 'success',
            latencyMs: result.completionMs,
          });
        } catch {
          result.message = isCancelled()
            ? 'Check cancelled.'
            : 'Generation failed. Check provider credentials, quota and supported model access.';
          result.completionMs = Date.now() - started;
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
    start() {
      if (current.running) return { id: current.id };
      current = { id: randomUUID(), running: true, cancelled: false, results: [], error: null };
      controller = new AbortController();
      emit();
      pending = run().catch(() => {
        current.running = false;
        current.error = 'Provider checks failed. Try again.';
        emit();
      });
      return { id: current.id };
    },
    progress(id?: string) {
      if (id !== undefined && id !== current.id)
        throw new Error('Provider check no longer available. Start a new check.');
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
