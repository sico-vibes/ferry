import { ProviderIdSchema, SettingsSchema } from '@ferry/shared';
import type { FerryServices } from './services.js';

export function providerBaseUrl(services: FerryServices, id: string): string | undefined {
  const envName = `FERRY_PROVIDER_BASE_URL_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const stored = SettingsSchema.safeParse(services.settings.get('global'));
  return (
    services.env[envName] ??
    (stored.success ? stored.data.providerEndpoints[ProviderIdSchema.parse(id)] : undefined)
  );
}
