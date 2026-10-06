import { DEFAULT_SETTINGS } from '@ferry/config';
import { ProfileSchema, SettingsPatchSchema, SettingsSchema } from '@ferry/shared';
import { FERRY_DOMAINS } from '@ferry/shared';
import { BUILTIN_PROFILES } from '@ferry/router';
import type { CoreHost } from '../host.js';
import { rpcDomainError } from '../host.js';
import type { FerryServices } from '../services.js';

const PatchSchema = SettingsPatchSchema;

export function register(host: CoreHost, services: FerryServices): void {
  const fallbackProfile =
    BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free') ?? BUILTIN_PROFILES[0];
  if (!fallbackProfile) throw new Error('No built-in profiles are configured');
  const profileIds = () => {
    const saved = services.settings.get('profiles');
    const savedIds = Array.isArray(saved)
      ? saved.flatMap((value) => {
          const parsed = ProfileSchema.safeParse(value);
          return parsed.success ? [parsed.data.id] : [];
        })
      : [];
    return new Set([...BUILTIN_PROFILES.map((profile) => profile.id), ...savedIds]);
  };
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
    const hasStored = Boolean(stored && typeof stored === 'object' && 'developer' in stored);
    const value = (hasStored ? stored : defaults) as {
      developer?: { realDomains?: unknown };
    };
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
    const migrated =
      hasStored && isOldDefault
        ? {
            ...value,
            developer: { ...value.developer, realDomains: defaults.developer.realDomains },
          }
        : value;
    const settings = SettingsSchema.parse(migrated);
    if (profileIds().has(settings.activeProfileId)) return settings;
    const repaired = SettingsSchema.parse({ ...settings, activeProfileId: fallbackProfile.id });
    services.settings.put('global', repaired);
    return repaired;
  };
  host.registerDomain('settings', {
    get() {
      return Promise.resolve().then(get);
    },
    update(raw: unknown) {
      return Promise.resolve().then(() => {
        const patch = PatchSchema.parse(raw);
        const current = get();
        if (patch.activeProfileId && !profileIds().has(patch.activeProfileId))
          throw rpcDomainError(-32044, 'not_found', `Profile not found: ${patch.activeProfileId}`);
        const settings = SettingsSchema.parse({
          ...current,
          ...patch,
          optimizers: { ...current.optimizers, ...patch.optimizers },
          developer: { ...current.developer, ...patch.developer },
          routing: { ...current.routing, ...patch.routing },
        });
        services.settings.put('global', settings);
        services.emitAppEvent('settings.changed', {
          keys: Object.keys(patch),
          values: patch,
        });
        if (patch.storageMode && patch.storageMode !== current.storageMode)
          services.emitAppEvent('storage.mode_changed', {
            from: current.storageMode,
            to: patch.storageMode,
          });
        host.emit('settings.updated', settings);
        return settings;
      });
    },
  });
}
