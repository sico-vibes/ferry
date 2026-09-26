import { DEFAULT_SETTINGS } from '@ferry/config';
import { SettingsSchema } from '@ferry/shared';
import { FERRY_DOMAINS } from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const PatchSchema = SettingsSchema.partial();

export function register(host: CoreHost, services: FerryServices): void {
  const defaults = SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    developer: {
      ...DEFAULT_SETTINGS.developer,
      realDomains: services.env.FERRY_REAL_DOMAINS?.split(',')
        .map((domain) => domain.trim())
        .filter(Boolean) ?? [...FERRY_DOMAINS],
    },
  });
  const get = () => {
    const stored = services.settings.get('global');
    if (!stored || typeof stored !== 'object' || !('developer' in stored)) return defaults;
    const value = stored as { developer?: { realDomains?: unknown } };
    const savedDomains = value.developer?.realDomains;
    const oldDefaults = [
      'settings,workspaces,checkpoints,sessions,approvals,providers,quota,models,profiles,skills,mcp,optimizer,delegation',
      'settings,workspaces,checkpoints,sessions,approvals,providers,oauth,quota,models,profiles,skills,mcp,optimizer,delegation',
    ].map((list) => list.split(','));
    oldDefaults.push([]);
    const isOldDefault =
      Array.isArray(savedDomains) &&
      oldDefaults.some(
        (list) =>
          list.length === savedDomains.length &&
          list.every((domain, index) => domain === savedDomains[index]),
      );
    const migrated = isOldDefault
      ? {
          ...value,
          developer: { ...value.developer, realDomains: defaults.developer.realDomains },
        }
      : stored;
    return SettingsSchema.parse(migrated);
  };
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
