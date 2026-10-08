import {
  COUNTED_FAILURE_KINDS,
  FailureEntrySchema,
  FailureKindSchema,
  RoutingSettingsSchema,
  newId,
  redactFailureMessage,
  type FailureEntry,
  type FailureKind,
  type Provider,
} from '@ferry/shared';
import { classifyProviderError } from '@ferry/router';
import type { FerryServices } from './services.js';

interface Binding {
  provider(id: string): Provider;
  emit(event: 'provider.updated' | 'toast', value: unknown): void;
}
const bindings = new WeakMap<FerryServices, Binding>();
const recordedAttempts = new WeakMap<object, string>();
export function markRecordedAttempt(error: unknown, requestId: string): void {
  if (error && typeof error === 'object') recordedAttempts.set(error, requestId);
}
export function isRecordedAttempt(error: unknown, requestId: string): boolean {
  return Boolean(error && typeof error === 'object' && recordedAttempts.get(error) === requestId);
}

export function bindRequestFailures(services: FerryServices, binding: Binding): void {
  bindings.set(services, binding);
}

/** Translate routing classification without changing routing policy. */
export function ledgerKind(family: string, status: number | null, message: string): FailureKind {
  if (family === 'cancelled' || family === 'local_reservation') return family;
  if (family === 'context_overflow' || family === 'request_too_large') return 'context_too_large';
  if (family === 'paid_required' || family === 'unsupported_free_tier') return 'quota_exhausted';
  if (family === 'offline') return 'network';
  if (family === 'stream_failure')
    return /no response|no output|empty response|no content|did not generate/i.test(message)
      ? 'no_response'
      : 'network';
  if (family === 'request_scoped_client' || family === 'content_filter') return 'bad_request';
  if (status === 403 && !/quota|credit|billing|payment|paid|free tier/i.test(message))
    return 'auth';
  const parsed = FailureKindSchema.safeParse(family);
  return parsed.success ? parsed.data : 'bad_request';
}

export function classifyLedgerError(error: unknown): {
  kind: FailureKind;
  statusCode: number | null;
  message: string;
} {
  const outer = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const source =
    outer.name === 'AI_StreamProviderError' && outer.cause && typeof outer.cause === 'object'
      ? (outer.cause as Record<string, unknown>)
      : outer;
  const typed = classifyProviderError({
    ...source,
    message: source.message ?? String(error),
    responseBody: source.responseBody ?? source.data,
  });
  return {
    kind: ledgerKind(typed.family, typed.status, typed.message),
    statusCode: typed.status,
    message: typed.message,
  };
}

export function recordRequestSuccess(
  services: FerryServices,
  providerId: string,
  modelRef: string,
): void {
  services.requestFailures.success(providerId, modelRef, services.clock.now().toISOString());
  const provider = services.catalog.providers.some((entry) => entry.provider === providerId)
    ? (bindings.get(services)?.provider(providerId) ?? services.providers.get(providerId))
    : services.providers.get(providerId);
  if (provider) bindings.get(services)?.emit('provider.updated', provider);
}

export function recordRequestFailure(
  services: FerryServices,
  input: Omit<FailureEntry, 'id' | 'at' | 'counted' | 'providerId' | 'modelRef'> & {
    providerId: string;
    modelRef: string;
  },
): void {
  const now = services.clock.now();
  services.requestFailures.put(
    FailureEntrySchema.parse({
      ...input,
      id: newId('failure'),
      at: now.toISOString(),
      message: redactFailureMessage(input.message),
      counted: COUNTED_FAILURE_KINDS.includes(input.kind) ? 1 : 0,
    }),
  );
  const binding = bindings.get(services);
  const provider = services.catalog.providers.some((entry) => entry.provider === input.providerId)
    ? (binding?.provider(input.providerId) ?? services.providers.get(input.providerId))
    : services.providers.get(input.providerId);
  if (!provider) return;
  const stored = services.settings.get('global') as { routing?: unknown } | undefined;
  const threshold =
    provider.autoPauseAfterFailedRequests ??
    RoutingSettingsSchema.parse(stored?.routing ?? {}).autoPauseAfterFailedRequests;
  const summary = services.requestFailures.summary([provider], now, provider.id).providers[0];
  if (
    threshold > 0 &&
    provider.enabled &&
    !provider.pausedReason &&
    summary &&
    summary.consecutive >= threshold
  ) {
    const paused: Provider = {
      ...provider,
      enabled: false,
      pausedReason: {
        kind: 'failed_requests',
        at: now.toISOString(),
        failedRequests: summary.consecutive,
        lastError: summary.lastError ?? '',
        lastKind: input.kind,
        models: summary.models
          .filter((model) => model.failed24h > 0)
          .map((model) => model.modelRef),
      },
    };
    services.providers.put(paused);
    binding?.emit('provider.updated', paused);
    binding?.emit('toast', {
      kind: 'warning',
      title: `${provider.name} paused after ${String(summary.consecutive)} failed requests`,
      body: paused.pausedReason?.lastError ?? null,
    });
  } else binding?.emit('provider.updated', provider);
}
