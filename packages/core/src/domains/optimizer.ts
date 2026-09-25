import { OptimizerStatsSchema, SettingsSchema } from '@ferry/shared';
import { DEFAULT_SETTINGS } from '@ferry/config';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

export function register(host: CoreHost, services: FerryServices): void {
  host.registerDomain('optimizer', {
    stats() {
      const events =
        services.optimizerEvents.list() as (typeof services.optimizerEvents extends never
          ? never
          : {
              id: string;
              sessionId: string;
              kind: string;
              beforeTokens?: number;
              afterTokens?: number;
              timestamp?: string;
            })[];
      const realEvents = events.filter(
        (event) => Number.isFinite(event.beforeTokens) && Number.isFinite(event.afterTokens),
      );
      const settings = SettingsSchema.parse(services.settings.get('global') ?? DEFAULT_SETTINGS);
      const groups = new Map<string, { before: number; after: number; count: number }>();
      for (const event of realEvents) {
        const group = groups.get(event.kind) ?? { before: 0, after: 0, count: 0 };
        group.before += event.beforeTokens ?? 0;
        group.after += event.afterTokens ?? 0;
        group.count += 1;
        groups.set(event.kind, group);
      }
      const byOptimizer = [...groups].map(([id, group]) => ({
        id,
        name: id.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
        enabled: settings.optimizers.toolOutputFilters,
        savedTokens: Math.max(0, group.before - group.after),
        percent:
          group.before === 0 ? 0 : Math.max(0, ((group.before - group.after) / group.before) * 100),
      }));
      const before = [...groups.values()].reduce((sum, group) => sum + group.before, 0);
      const savedTokens = byOptimizer.reduce((sum, group) => sum + group.savedTokens, 0);
      return OptimizerStatsSchema.parse({
        demo: realEvents.length === 0,
        today: {
          savedTokens,
          percent: before === 0 ? 0 : Math.min(100, (savedTokens / before) * 100),
        },
        byOptimizer,
      });
    },
  });
}
