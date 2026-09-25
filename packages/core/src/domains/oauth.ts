import { execFile } from 'node:child_process';
import { OAuthLoginProgressSchema, OAuthProviderIdSchema, ProviderSchema } from '@ferry/shared';
import { listOAuthProviders, logout, oauthModelCatalog, startLogin } from '@ferry/oauth';
import type { OAuthLoginEvent } from '@ferry/oauth';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

function openUrl(url: string): Promise<void> {
  const command =
    process.platform === 'win32'
      ? 'rundll32.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(new Error('Could not open the sign-in page'));
      else resolve();
    });
  });
}

export function register(host: CoreHost, services: FerryServices): void {
  const connected = async (id: string) =>
    services.secrets.has(`oauth:${OAuthProviderIdSchema.parse(id)}`);
  host.registerDomain('oauth', {
    async list() {
      const providers = await listOAuthProviders();
      return Promise.all(
        providers.map(async (provider) => ({
          ...provider,
          connected: await connected(provider.id),
        })),
      );
    },
    async status(rawId: unknown) {
      return await connected(OAuthProviderIdSchema.parse(rawId));
    },
    async login(rawId: unknown) {
      const id = OAuthProviderIdSchema.parse(rawId);
      const emit = (event: OAuthLoginEvent) => {
        if (event.type === 'open_url')
          host.emit('oauth.progress', OAuthLoginProgressSchema.parse({ ...event, id }));
        else if (event.type === 'device_code')
          host.emit('oauth.progress', OAuthLoginProgressSchema.parse({ ...event, id }));
        else if (event.type === 'success' || event.type === 'error')
          host.emit('oauth.progress', OAuthLoginProgressSchema.parse({ ...event, id }));
      };
      await startLogin(
        id,
        {
          openUrl,
          onDeviceCode: () => undefined,
          onProgress: emit,
        },
        services.secrets,
      );
      const metadata = (await listOAuthProviders()).find((item) => item.id === id);
      if (metadata)
        services.providers.put(
          ProviderSchema.parse({
            id,
            name: metadata.name,
            tag: 'subscription_oauth',
            kind: 'api',
            brand: null,
            keyStatus: 'valid',
            enabled: true,
            health: 'ok',
            cooldownUntil: null,
            dataUse: null,
            termsNote: metadata.riskText,
            signupUrl: null,
            docsUrl: null,
            verifiedAt: services.clock.now().toISOString().slice(0, 10),
            modelCount: oauthModelCatalog.filter((model) => model.providerId === id).length,
            windows: [],
            stepsLeftToday: null,
          }),
        );
    },
    async logout(rawId: unknown) {
      const id = OAuthProviderIdSchema.parse(rawId);
      await logout(id, services.secrets);
      const saved = services.providers.get(id);
      if (saved)
        services.providers.put({
          ...saved,
          enabled: false,
          keyStatus: 'missing',
          health: 'unknown',
        });
    },
  });
}
