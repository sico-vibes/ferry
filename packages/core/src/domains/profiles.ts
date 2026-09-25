import { ProfileIdSchema, ProfileSchema, SessionIdSchema, SettingsSchema } from '@ferry/shared';
import { DEFAULT_SETTINGS } from '@ferry/config';
import { BUILTIN_PROFILES } from '@ferry/router';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const savedProfiles = (services: FerryServices) => {
  const value = services.settings.get('profiles');
  return Array.isArray(value) ? value.map((profile) => ProfileSchema.parse(profile)) : [];
};

export function register(host: CoreHost, services: FerryServices): void {
  const list = () => [...BUILTIN_PROFILES, ...savedProfiles(services)];
  host.registerDomain('profiles', {
    list() {
      return list().map((profile) => ProfileSchema.parse(profile));
    },
    save(rawProfile: unknown) {
      const profile = ProfileSchema.parse(rawProfile);
      const current = savedProfiles(services);
      if (profile.builtin || BUILTIN_PROFILES.some((item) => item.id === profile.id))
        throw rpcDomainError(-32010, 'validation', 'Built-in profiles cannot be overwritten');
      const next = current.filter((item) => item.id !== profile.id);
      next.push(profile);
      services.settings.put('profiles', next);
      return profile;
    },
    remove(rawId: unknown) {
      const id = ProfileIdSchema.parse(rawId);
      if (BUILTIN_PROFILES.some((profile) => profile.id === id))
        throw rpcDomainError(-32010, 'validation', 'Built-in profiles cannot be removed');
      const next = savedProfiles(services).filter((profile) => profile.id !== id);
      if (next.length === savedProfiles(services).length)
        throw rpcDomainError(-32044, 'not_found', `Profile not found: ${id}`);
      services.settings.put('profiles', next);
    },
    activate(rawId: unknown, rawSessionId?: unknown) {
      const id = ProfileIdSchema.parse(rawId);
      if (!list().some((profile) => profile.id === id))
        throw rpcDomainError(-32044, 'not_found', `Profile not found: ${id}`);
      if (rawSessionId !== undefined) {
        const sessionId = SessionIdSchema.parse(rawSessionId);
        const session = services.sessions.get(sessionId);
        if (!session) throw rpcDomainError(-32044, 'not_found', `Session not found: ${sessionId}`);
        services.sessions.put({
          ...session,
          profileId: id,
          updatedAt: services.clock.now().toISOString(),
        });
        return;
      }
      const current = SettingsSchema.parse(services.settings.get('global') ?? DEFAULT_SETTINGS);
      const updated = SettingsSchema.parse({ ...current, activeProfileId: id });
      services.settings.put('global', updated);
      host.emit('settings.updated', updated);
    },
  });
}
