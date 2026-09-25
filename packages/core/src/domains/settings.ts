import { DEFAULT_SETTINGS } from '@ferry/config';
import { SettingsSchema } from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const PatchSchema = SettingsSchema.partial();

export function register(host: CoreHost, services: FerryServices): void {
  const defaults = SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    developer: {
      ...DEFAULT_SETTINGS.developer,
      realDomains:
        services.env.FERRY_REAL_DOMAINS?.split(',')
          .map((domain) => domain.trim())
          .filter(Boolean) ?? [],
    },
  });
  const get = () => SettingsSchema.parse(services.settings.get('global') ?? defaults);
  host.registerDomain('settings', {
    get() {
      return Promise.resolve().then(get);
    },
    update(raw: unknown) {
      return Promise.resolve().then(() => {
        const patch = PatchSchema.parse(raw);
        const current = get();
        const settings = SettingsSchema.parse({
          ...current,
          ...patch,
          optimizers: { ...current.optimizers, ...patch.optimizers },
          developer: { ...current.developer, ...patch.developer },
        });
        services.settings.put('global', settings);
        host.emit('settings.updated', settings);
        return settings;
      });
    },
  });
}
