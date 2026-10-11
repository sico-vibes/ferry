import type { ModelStats } from '@ferry/router';
import { ProviderCheckResultSchema } from '@ferry/shared';
import type { FerryServices } from './services.js';
import { getProviderHealth } from './provider-health.js';

/** Prefer observed first response; fall back to generation timings, never synthetic priors labelled measured. */
export function modelRoutingStats(services: FerryServices): ModelStats[] {
  const cutoff = new Date(services.clock.now().getTime() - 7 * 86_400_000).toISOString();
  const observed = services.db.client
    .prepare(
      "SELECT model AS ref, avg(latency_ms) AS latency FROM requests WHERE ts >= ? AND status='success' AND latency_ms IS NOT NULL GROUP BY model",
    )
    .all(cutoff) as { ref: string; latency: number }[];
  const first = services.db.client
    .prepare(
      "SELECT json_extract(data_json,'$.modelRef') AS ref,avg(json_extract(data_json,'$.firstResponseMs')) AS latency FROM gateway_requests WHERE at >= ? AND json_extract(data_json,'$.status')='ok' AND json_extract(data_json,'$.firstResponseMs') IS NOT NULL GROUP BY ref",
    )
    .all(cutoff) as { ref: string; latency: number }[];
  const latency = new Map([...observed, ...first].map((row) => [row.ref, row.latency]));
  for (const check of ProviderCheckResultSchema.array().safeParse(
    services.settings.get('provider-check-results'),
  ).data ?? []) {
    if (
      check.ok &&
      check.firstResponseMs !== null &&
      check.at >= cutoff &&
      !latency.has(check.modelRef)
    )
      latency.set(check.modelRef, check.firstResponseMs);
  }
  return services.catalog.models.map((model) => ({
    modelRef: model.ref,
    toolCalls: 0,
    toolCallValidationFailures: 0,
    cacheAffinity: 0,
    averageLatencyMs:
      latency.get(model.ref) ?? getProviderHealth(services).snapshot(model.providerId).latencyP50Ms,
  }));
}
