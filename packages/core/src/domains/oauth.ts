import { execFile } from 'node:child_process';
import {
  OAuthLoginProgressSchema,
  OAuthProviderIdSchema,
  ProviderSchema,
  rememberSecret,
  oauthConnectionId,
  providerDefinition,
  PROVIDER_REGISTRY,
} from '@ferry/shared';
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
  const logins = new Map<string, AbortController>();
  const prompts = new Map<string, { provider: string; resolve(value: string): void }>();
  host.onShutdown(() => {
    for (const login of logins.values()) login.abort();
  });
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
        ...PROVIDER_REGISTRY.filter(
          (entry) => entry.auth === 'oauth' && entry.releaseState === 'Coming soon',
        ).map((entry) => ({
          id: entry.oauthProviderId ?? entry.id,
          name: entry.name,
          tag: 'legit' as const,
          subscriptionRequired: false,
          models: [],
          riskLevel: 'low' as const,
          riskText: 'Account sign-in is coming soon.',
          group: 'coming_soon' as const,
          actionAvailable: false,
          signupUrl: entry.docsSource,
        })),
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
      const results = await Promise.allSettled(
        providers.map(async (provider) => {
          if (provider.group === 'unavailable')
            return { ...provider, connected: false, status: 'unavailable' as const, account: null };
          return { ...provider, ...(await connection(provider.id)) };
        }),
      );
      return results.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        const error: unknown = result.reason;
        return {
          ...providers[index],
          connected: false,
          status: 'unavailable' as const,
          account: null,
          actionAvailable: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      });
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
      if (providerDefinition(`oauth-${id}`)?.releaseState === 'Coming soon')
        throw new Error(`${id} login is coming soon.`);
      if (!isSupportedOAuthProvider(id))
        throw new Error(`OAuth login is unavailable for ${String(id)}`);
      if (id === 'radius' && !input.gateway) throw new Error('Radius requires a gateway URL');
      if (logins.size)
        throw new Error('Finish or cancel the current sign-in before starting another');
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new Error('Sign-in timed out. Start again.'));
      }, 10 * 60_000);
      timeout.unref();
      logins.set(id, controller);
      const emit = (event: OAuthLoginEvent) => {
        host.emit('oauth.progress', OAuthLoginProgressSchema.parse({ ...event, id }));
      };
      host.emit('oauth.progress', { type: 'progress', id, message: 'Preparing sign-in…' });
      try {
        await startLogin(
          id,
          {
            openUrl,
            signal: controller.signal,
            onPrompt: (prompt, signal) =>
              new Promise<string>((resolve, reject) => {
                const promptId = globalThis.crypto.randomUUID();
                const cleanup = () => {
                  prompts.delete(promptId);
                  signal.removeEventListener('abort', aborted);
                  controller.signal.removeEventListener('abort', aborted);
                };
                const aborted = () => {
                  cleanup();
                  reject(
                    controller.signal.reason instanceof Error
                      ? controller.signal.reason
                      : new Error('Sign-in cancelled'),
                  );
                };
                if (signal.aborted || controller.signal.aborted) {
                  aborted();
                  return;
                }
                prompts.set(promptId, {
                  provider: id,
                  resolve: (value) => {
                    cleanup();
                    resolve(value);
                  },
                });
                signal.addEventListener('abort', aborted, { once: true });
                controller.signal.addEventListener('abort', aborted, { once: true });
                host.emit(
                  'oauth.progress',
                  OAuthLoginProgressSchema.parse({ ...prompt, type: 'prompt', promptId, id }),
                );
              }),
            onDeviceCode: () => undefined,
            onProgress: emit,
            ...(input.gateway ? { gateway: input.gateway } : {}),
          },
          services.secrets,
        );
      } catch (error) {
        emit({ type: 'error', message: error instanceof Error ? error.message : 'Sign-in failed' });
        throw error;
      } finally {
        clearTimeout(timeout);
        controller.abort();
        logins.delete(id);
      }
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
            id: oauthConnectionId(id),
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
            modelCount: oauthModelCatalog.filter(
              (model) => model.providerId === oauthConnectionId(id),
            ).length,
            windows: [],
            stepsLeftToday: null,
          }),
        );
    },
    respond(rawId: unknown, rawPromptId: unknown, rawValue: unknown) {
      const id = OAuthProviderIdSchema.parse(rawId);
      if (
        typeof rawPromptId !== 'string' ||
        typeof rawValue !== 'string' ||
        rawValue.length > 16384
      )
        throw new Error('Invalid sign-in response');
      const prompt = prompts.get(rawPromptId);
      if (prompt?.provider !== id) throw new Error('This sign-in prompt is no longer active');
      if (rawValue) rememberSecret(rawValue);
      prompt.resolve(rawValue);
      return Promise.resolve();
    },
    cancel(rawId: unknown) {
      const id = OAuthProviderIdSchema.parse(rawId);
      logins.get(id)?.abort(new Error('Sign-in cancelled'));
      return Promise.resolve();
    },
    async logout(rawId: unknown) {
      const id = OAuthProviderIdSchema.parse(rawId);
      await logout(id, services.secrets);
      if (id === 'openrouter') services.providerKeys.delete(id);
      const saved = services.providers.get(oauthConnectionId(id));
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
