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
              runId?: string;
              beforeTokens?: number;
              afterTokens?: number;
              timestamp?: string;
            })[];
      const realEvents = events.filter(
        (event) => Number.isFinite(event.beforeTokens) && Number.isFinite(event.afterTokens),
      );
      const today = services.clock.now().toISOString().slice(0, 10);
      const todayEvents = realEvents.filter(
        (event) => (event.timestamp ?? '').slice(0, 10) === today,
      );
      const settings = SettingsSchema.parse(services.settings.get('global') ?? DEFAULT_SETTINGS);
      const groups = new Map<string, { before: number; after: number; count: number }>();
      for (const event of todayEvents) {
        const group = groups.get(event.kind) ?? { before: 0, after: 0, count: 0 };
        group.before += event.beforeTokens ?? 0;
        group.after += event.afterTokens ?? 0;
        group.count += 1;
        groups.set(event.kind, group);
      }
      const cavemanEvents = realEvents.filter((event) => event.kind === 'caveman-input');
      const latestCaveman = cavemanEvents.reduce<(typeof cavemanEvents)[number] | undefined>(
        (latest, event) =>
          !latest || (event.timestamp ?? '') >= (latest.timestamp ?? '') ? event : latest,
        undefined,
      );
      const lastRun = latestCaveman
        ? cavemanEvents.filter(
            (event) =>
              event.sessionId === latestCaveman.sessionId && event.runId === latestCaveman.runId,
          )
        : [];
      const lastBefore = lastRun.reduce((sum, event) => sum + (event.beforeTokens ?? 0), 0);
      const lastAfter = lastRun.reduce((sum, event) => sum + (event.afterTokens ?? 0), 0);
      const byOptimizer = [...groups].map(([id, group]) => {
        const enabled =
          id === 'caveman-input'
            ? true // Profile-driven; global toggles may be off while Auto-Free uses it.
            : id === 'recovery-read'
              ? settings.optimizers.recoveryHandles
              : id.startsWith('terse-')
                ? settings.optimizers.terse !== 'off'
                : id === 'context-hygiene' || id === 'context-compaction'
                  ? settings.optimizers.contextHygiene
                  : settings.optimizers.toolOutputFilters;
        return {
          id,
          name: id.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
          enabled,
          savedTokens: Math.max(0, group.before - group.after),
          percent:
            group.before === 0
              ? 0
              : Math.max(0, ((group.before - group.after) / group.before) * 100),
        };
      });
      const before = [...groups.values()].reduce((sum, group) => sum + group.before, 0);
      const after = [...groups.values()].reduce((sum, group) => sum + group.after, 0);
      const savedTokens = Math.max(0, before - after);
      return OptimizerStatsSchema.parse({
        demo: todayEvents.length === 0,
        today: {
          savedTokens,
          percent: before === 0 ? 0 : Math.min(100, (savedTokens / before) * 100),
          samples: todayEvents.length,
        },
        cavemanLastRun: latestCaveman
          ? {
              sessionId: latestCaveman.sessionId,
              ...(latestCaveman.runId ? { runId: latestCaveman.runId } : {}),
              savedTokens: Math.max(0, lastBefore - lastAfter),
              percent:
                lastBefore === 0
                  ? 0
                  : Math.max(0, Math.min(100, ((lastBefore - lastAfter) / lastBefore) * 100)),
              samples: lastRun.length,
            }
          : null,
        byOptimizer,
      });
    },
  });
}
