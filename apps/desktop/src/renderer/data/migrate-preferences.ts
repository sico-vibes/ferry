import { UserPermissionRuleSchema, type Settings } from '@ferry/shared';
import type { FerryClient } from '@ferry/client';

/** Core's marker wins across restarts and windows; delete browser values only after saving. */
export async function migrateBrowserPreferences(
  client: FerryClient,
  settings: Settings,
): Promise<Settings> {
  if (settings.browserPreferencesMigrated) return settings;
  const patch: Parameters<FerryClient['settings']['update']>[0] = {
    browserPreferencesMigrated: true,
  };
  const raw = localStorage.getItem('ferry.permissionRules');
  if (raw && !settings.permissionRules.length) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value))
        patch.permissionRules = value.flatMap((rule: unknown) => {
          const parsed = UserPermissionRuleSchema.safeParse(rule);
          return parsed.success ? [parsed.data] : [];
        });
    } catch {
      /* Invalid old preferences must not break startup. */
    }
  }
  const retention = localStorage.getItem('ferry.logRetention');
  if (retention === 'forever') patch.logRetentionDays = null;
  else if (retention && ['7', '30', '90'].includes(retention))
    patch.logRetentionDays = Number(retention);
  const saved = await client.settings.update(patch);
  localStorage.removeItem('ferry.permissionRules');
  localStorage.removeItem('ferry.logRetention');
  return { ...settings, ...patch, ...saved };
}
