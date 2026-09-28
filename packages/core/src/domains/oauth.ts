import { execFile } from 'node:child_process';
import { OAuthLoginProgressSchema, OAuthProviderIdSchema, ProviderSchema } from '@ferry/shared';
import {
  isSupportedOAuthProvider,
  listOAuthProviders,
  logout,
  oauthModelCatalog,
  startLogin,
} from '@ferry/oauth';
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
  const connection = async (id: string) => {
    const providerId = OAuthProviderIdSchema.parse(id);
    const value = await services.secrets.get(
      providerId === 'openrouter' ? 'openrouter' : `oauth:${providerId}`,
    );
    if (!value) return { connected: false, status: 'not_connected' as const, account: null };
    if (providerId === 'openrouter')
      return { connected: true, status: 'connected' as const, account: null };
    try {
      const credential: unknown = JSON.parse(value);
      if (typeof credential === 'object' && credential !== null) {
        const fields = credential as Record<string, unknown>;
        const expired = typeof fields.expires === 'number' && fields.expires <= Date.now();
        const account = ['email', 'username', 'accountName', 'account']
          .map((field) => fields[field])
          .find((field): field is string => typeof field === 'string' && field.length > 0);
        return {
          connected: !expired,
          status: expired ? ('expired' as const) : ('connected' as const),
          account: account ?? null,
        };
      }
    } catch {
      return { connected: false, status: 'expired' as const, account: null };
    }
    return { connected: false, status: 'expired' as const, account: null };
  };
  host.registerDomain('oauth', {
    async list() {
      const providers = [
        ...(await listOAuthProviders()),
        {
          id: 'kilo' as const,
          tag: 'legit' as const,
          name: 'Kilo Gateway',
          subscriptionRequired: false,
          models: [],
          riskLevel: 'low' as const,
          riskText: 'Account OAuth and API-key setup are coming soon.',
          group: 'unavailable' as const,
          actionAvailable: false as const,
          signupUrl: 'https://kilo.ai/',
        },
        {
          id: 'qoder' as const,
          tag: 'legit' as const,
          name: 'Qoder',
          subscriptionRequired: false,
          models: [],
          riskLevel: 'low' as const,
          riskText: 'PAT and browser OAuth support are coming soon.',
          group: 'unavailable' as const,
          actionAvailable: false as const,
          signupUrl: 'https://qoder.com/',
        },
        {
          id: 'cline' as const,
          tag: 'legit' as const,
          name: 'Cline',
          subscriptionRequired: false,
          models: [],
          riskLevel: 'low' as const,
          riskText: 'Account login is coming soon.',
          group: 'unavailable' as const,
          actionAvailable: false as const,
          signupUrl: 'https://cline.bot/',
        },
        {
          id: 'gemini-cli' as const,
          tag: 'subscription_oauth' as const,
          name: 'Gemini CLI',
          subscriptionRequired: true,
          models: [],
          riskLevel: 'high' as const,
          riskText: 'Removed from pi-ai; Google ended the Gemini CLI free login 2026-06-18.',
          group: 'unavailable' as const,
          actionAvailable: false as const,
        },
        {
          id: 'antigravity' as const,
          tag: 'subscription_oauth' as const,
          name: 'Antigravity',
          subscriptionRequired: true,
          models: [],
          riskLevel: 'high' as const,
          riskText: 'Removed from pi-ai; Antigravity OAuth reuse led to bans.',
          group: 'unavailable' as const,
          actionAvailable: false as const,
        },
      ];
      return Promise.all(
        providers.map(async (provider) => ({
          ...provider,
          ...(await connection(provider.id)),
        })),
      );
    },
    async status(rawId: unknown) {
      return (await connection(OAuthProviderIdSchema.parse(rawId))).connected;
    },
    async login(...params: unknown[]) {
      const [rawInput, rawOptions] = params;
      const options =
        typeof rawOptions === 'object' && rawOptions !== null && 'gateway' in rawOptions
          ? { gateway: typeof rawOptions.gateway === 'string' ? rawOptions.gateway : undefined }
          : undefined;
      const input =
        typeof rawInput === 'object' && rawInput !== null && 'id' in rawInput
          ? (rawInput as { id: unknown; gateway?: string })
          : { id: rawInput, ...options };
      const id = OAuthProviderIdSchema.parse(input.id);
      if (!isSupportedOAuthProvider(id))
        throw new Error(`OAuth login is unavailable for ${String(id)}`);
      if (id === 'radius' && !input.gateway) throw new Error('Radius requires a gateway URL');
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
          ...(input.gateway ? { gateway: input.gateway } : {}),
        },
        services.secrets,
      );
      const metadata = (await listOAuthProviders()).find((item) => item.id === id);
      if (id === 'openrouter') {
        services.providerKeys.put({
          id,
          providerId: id,
          keyringRef: id,
          createdAt: services.clock.now().toISOString(),
        });
        const existing = services.providers.get(id);
        if (existing)
          services.providers.put({ ...existing, keyStatus: 'valid', enabled: true, health: 'ok' });
      } else if (metadata)
        services.providers.put(
          ProviderSchema.parse({
            id,
            name: metadata.name,
            tag: metadata.tag,
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
      if (id === 'openrouter') services.providerKeys.delete(id);
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
