import {
  CapacitySummarySchema,
  HandoffStatSchema,
  UsageHistoryPointSchema,
  type UsageHistoryPoint,
} from '@ferry/shared';
import { z } from 'zod';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const DaysSchema = z.number().int().min(1).max(365);

export function register(host: CoreHost, services: FerryServices): void {
  const emitUpdate = () => {
    host.emit('quota.updated', CapacitySummarySchema.parse(services.quota.capacitySummary()));
  };
  services.quota.subscribe(() => {
    emitUpdate();
  });
  host.registerDomain('quota', {
    capacity() {
      return Promise.resolve(CapacitySummarySchema.parse(services.quota.capacitySummary()));
    },
    history(rawDays: unknown) {
      return Promise.resolve()
        .then(() => {
          const days = DaysSchema.parse(rawDays);
          const cutoff = services.clock.now().getTime() - days * 86_400_000;
          const rows = new Map<string, UsageHistoryPoint>();
          for (const usage of services.quota.queryUsage()) {
            if (Date.parse(usage.occurredAt) < cutoff) continue;
            const date = usage.occurredAt.slice(0, 10);
            const key = `${date}:${usage.providerId}`;
            const point = rows.get(key) ?? {
              date,
              providerId: usage.providerId,
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            };
            point.requests += 1;
            point.inputTokens += usage.inputTokens ?? 0;
            point.outputTokens += usage.outputTokens ?? 0;
            point.costUsd += usage.costUsd ?? 0;
            rows.set(key, point);
          }
          for (const observation of services.quotaObservations.list()) {
            if (
              observation.source === 'learned' ||
              observation.value === undefined ||
              Date.parse(observation.observedAt) < cutoff
            )
              continue;
            const date = observation.observedAt.slice(0, 10);
            const key = `${date}:${observation.providerId}`;
            const point = rows.get(key) ?? {
              date,
              providerId: observation.providerId,
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            };
            if (observation.metric === 'requests')
              point.requests = Math.max(point.requests, observation.value);
            if (observation.metric === 'tokens')
              point.inputTokens = Math.max(point.inputTokens, observation.value);
            rows.set(key, point);
          }
          return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
        })
        .then((rows) => rows.map((row) => UsageHistoryPointSchema.parse(row)));
    },
    handoffs(rawDays: unknown) {
      return Promise.resolve().then(() => {
        const days = DaysSchema.parse(rawDays);
        const since = new Date(services.clock.now().getTime() - days * 86_400_000);
        const counts = new Map<string, number>();
        for (const handoff of services.handoffs.listSince(since))
          counts.set(handoff.reason, (counts.get(handoff.reason) ?? 0) + 1);
        return [...counts].map(([reason, count]) => HandoffStatSchema.parse({ reason, count }));
      });
    },
  });
}
