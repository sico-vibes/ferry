import { SettingsSchema } from '@ferry/shared';
import { DEFAULT_SETTINGS } from '@ferry/config';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

export function register(host: CoreHost, services: FerryServices): void {
  const publish = async () => {
    host.emit('cloud.status', await services.cloud.status());
  };
  services.cloud.onChange(() => {
    void publish();
  });
  host.registerDomain('cloud', {
    status: () => services.cloud.status(),
    async signIn(input: unknown) {
      if (!input || typeof input !== 'object') throw new Error('Email and password are required.');
      const { email, password } = input as { email?: unknown; password?: unknown };
      if (typeof email !== 'string' || typeof password !== 'string')
        throw new Error('Email and password are required.');
      if (!services.cloud.auth)
        throw new Error('Restart Ferry in configured cloud mode to sign in.');
      try {
        const result = await services.cloud.auth.signInWithPassword(email, password);
        services.emitAppEvent('auth.login', { userId: result.userId });
        await publish();
        return result;
      } catch (error) {
        services.emitAppEvent('auth.login_failed', {}, 'warn');
        throw error;
      }
    },
    async signOut() {
      if (!services.cloud.auth) throw new Error('Cloud sign-in is unavailable until restart.');
      await services.cloud.auth.signOut();
      services.emitAppEvent('auth.logout');
      await publish();
    },
    async setStorageMode(input: unknown) {
      const mode = (input as { mode?: unknown } | null)?.mode;
      if (mode !== 'local' && mode !== 'cloud')
        throw new Error('Storage mode must be local or cloud.');
      const oldSettings = services.settings.get('global') as Record<string, unknown> | undefined;
      const settings = SettingsSchema.parse({
        ...DEFAULT_SETTINGS,
        ...(oldSettings ?? {}),
        storageMode: mode,
      });
      services.settings.put('global', settings);
      services.emitAppEvent('storage.mode_changed', {
        from: oldSettings?.storageMode ?? 'local',
        to: mode,
      });
      await publish();
      return { mode, restartRequired: true };
    },
    async syncNow() {
      return await services.cloud.syncNow();
    },
    async setCaptureContent(input: unknown) {
      const value = (input as { value?: unknown } | null)?.value;
      if (value !== null && typeof value !== 'boolean')
        throw new Error('Capture setting must be true, false, or null.');
      const oldSettings = services.settings.get('global') as Record<string, unknown> | undefined;
      const merged = { ...DEFAULT_SETTINGS, ...(oldSettings ?? {}) } as Record<string, unknown>;
      if (value === null) delete merged.captureContent;
      else merged.captureContent = value;
      const settings = SettingsSchema.parse(merged);
      services.settings.put('global', settings);
      services.emitAppEvent('settings.changed', {
        keys: ['captureContent'],
        values: { captureContent: value },
      });
      await publish();
      return settings.captureContent;
    },
    migrateLocalKeys: () => services.cloud.migrateLocalKeys(),
  });
}
