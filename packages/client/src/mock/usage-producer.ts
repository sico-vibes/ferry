import type { ModelRef } from '@ferry/shared';

/**
 * The actual model that can be attributed to a reply or request. A logical Gateway key routes a
 * request but is never itself the LLM, so it is reported as unknown (`null`) rather than claimed.
 */
export function honestProducer(ref: ModelRef | null): ModelRef | null {
  if (!ref || ref.startsWith('gateway/')) return null;
  return ref;
}

/** Explicit unknown model key for a retained request whose actual producer is not evidenced. */
const UNKNOWN_USAGE_MODEL = 'unknown';

/**
 * The `(modelRef, providerId)` a finalized mock request is attributed to. A real model keeps its own
 * ref and provider; a logical Gateway key is recorded under an explicit unknown key with no provider,
 * so a gateway alias is never mislabelled as the LLM that served the request. The request count is
 * still preserved; only the unprovable attribution is left unknown.
 */
export function usageAttribution(ref: ModelRef | null): {
  modelRef: string;
  providerId: string | null;
} {
  const producer = honestProducer(ref);
  if (!producer) return { modelRef: UNKNOWN_USAGE_MODEL, providerId: null };
  return { modelRef: producer, providerId: producer.split('/')[0] ?? null };
}
