import { resolveProviderRequestOverrides, streamProviderChat } from '@ferry/providers';
import type { ModelMessage } from '@ferry/providers';
import { genericFilter, terseSystemText } from '@ferry/optimizer';
import {
  BUILTIN_PROFILES,
  classifyProviderError,
  resolveLogicalModelCandidates,
} from '@ferry/router';
import { RoutingSettingsSchema } from '@ferry/shared';
import {
  type GatewayRuntime,
  startGateway,
  createGatewayKey,
  type GatewayKey,
  type GatewayHandle,
  type GatewayMessage,
} from '@ferry/gateway';
import type { FerryServices } from './services.js';

interface GatewaySettings {
  enabled: boolean;
  port: number;
  allowLan: boolean;
}
const defaultSettings: GatewaySettings = { enabled: false, port: 11435, allowLan: false };
function keys(services: FerryServices): GatewayKey[] {
  const stored = services.settings.get('gateway-keys');
  return Array.isArray(stored) ? (stored as GatewayKey[]) : [];
}
function gatewaySettings(services: FerryServices): GatewaySettings {
  const stored = services.settings.get('gateway-settings');
  return stored && typeof stored === 'object' ? { ...defaultSettings, ...stored } : defaultSettings;
}
export function toGatewayModelMessages(messages: GatewayMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    const role = message.role;
    if (role === 'assistant' && message.tool_calls?.length) {
      const content = message.tool_calls.flatMap((call) => {
        let input: unknown;
        try {
          input = JSON.parse(call.function.arguments) as unknown;
        } catch {
          input = {};
        }
        return [
          { type: 'tool-call' as const, toolCallId: call.id, toolName: call.function.name, input },
        ];
      });
      return [
        ...(typeof message.content === 'string' && message.content
          ? [{ role: 'assistant' as const, content: message.content }]
          : []),
        { role: 'assistant', content: content as never },
      ];
    }
    if (role === 'user' || role === 'assistant') {
      if (typeof message.content === 'string') return [{ role, content: message.content }];
      if (Array.isArray(message.content)) return [{ role, content: message.content as never }];
      return [];
    }
    if (role === 'tool' && message.tool_call_id)
      return [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.tool_call_id,
              toolName: message.name ?? '',
              output: {
                type: 'text',
                value:
                  typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content ?? ''),
              },
            },
          ],
        },
      ];
    return [];
  });
}
function compressedMessages(messages: GatewayMessage[], enabled: boolean): GatewayMessage[] {
  if (!enabled) return messages;
  return messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    const filtered = genericFilter(message.content);
    return filtered === message.content
      ? message
      : {
          ...message,
          content: `[Ferry compressed this tool result; recovery storage is disabled.]\n${filtered}`,
        };
  });
}
function profileId(raw: string): string {
  if (raw === 'auto-free') return 'profile_builtin_auto_free';
  if (raw === 'best') return 'profile_builtin_best_available';
  if (raw === 'fast') return 'profile_builtin_fast';
  if (raw === 'long-context') return 'profile_builtin_long_context';
  return raw;
}

function routingSettings(services: FerryServices) {
  const global = services.settings.get('global');
  const routing =
    global && typeof global === 'object' ? (global as { routing?: unknown }).routing : {};
  return RoutingSettingsSchema.parse(routing ?? {});
}

export function createGatewayController(services: FerryServices) {
  let handle: GatewayHandle | undefined;
  const stickyRoutes = new Map<
    string,
    {
      modelRef: string;
      providerId?: string | undefined;
      providerKeyId?: string | undefined;
      expiresAt: number;
    }
  >();
  const allModels = () =>
    [
      ...services.catalog.models,
      ...services.catalog.providers.flatMap(({ provider }) => services.models.list(provider)),
    ]
      .filter((model) => {
        const saved = services.providers.get(model.providerId);
        const configured = services.catalog.providers.find(
          (entry) => entry.provider === model.providerId,
        );
        const availableCredentials =
          Boolean(services.providerKeys.get(model.providerId)) ||
          configured?.key_required === false;
        return (
          (saved?.enabled ?? availableCredentials) &&
          availableCredentials &&
          !saved?.excludedModelRefs?.includes(model.ref)
        );
      })
      .map((model) => model.ref);
  const routeableCandidates = async (key: GatewayKey, profileName: string, inputTokens = 1) => {
    const allProfiles = [...BUILTIN_PROFILES];
    const custom = services.settings.get('profiles');
    if (Array.isArray(custom)) allProfiles.push(...(custom as typeof BUILTIN_PROFILES));
    const selected = allProfiles.find((entry) => entry.id === profileId(profileName));
    if (!selected) return [];
    const runtimeDeps = await import('./session-deps.js');
    const requestDeps = runtimeDeps.createSessionDependencies(services, () => undefined);
    const eligible = requestDeps.gateway.resolveCandidates(selected, 'plan', inputTokens);
    const allowedConcrete = key.allowedModels.filter(
      (ref) => ref.includes('/') && !ref.startsWith('ferry/'),
    );
    return allowedConcrete.length
      ? eligible.filter((model) => allowedConcrete.includes(model.ref))
      : eligible;
  };
  const runtime: GatewayRuntime = {
    store: {
      list: () => keys(services),
      put: (key) => {
        services.settings.put('gateway-keys', [
          ...keys(services).filter((entry) => entry.id !== key.id),
          key,
        ]);
      },
      delete: (id) => {
        services.settings.put(
          'gateway-keys',
          keys(services).filter((entry) => entry.id !== id),
        );
      },
      touch: (id, at) => {
        services.settings.put(
          'gateway-keys',
          keys(services).map((entry) => (entry.id === id ? { ...entry, lastUsedAt: at } : entry)),
        );
      },
      usage: (id) => {
        const value = services.settings.get(`gateway-usage:${id}`);
        return value && typeof value === 'object'
          ? (value as { requests: number; inputTokens: number; outputTokens: number })
          : { requests: 0, inputTokens: 0, outputTokens: 0 };
      },
      recordUsage: (id, inputTokens, outputTokens) => {
        const current = runtime.store.usage(id);
        services.settings.put(`gateway-usage:${id}`, {
          requests: current.requests + 1,
          inputTokens: current.inputTokens + inputTokens,
          outputTokens: current.outputTokens + outputTokens,
        });
      },
    },
    async models(key, profileName = key.profile) {
      const eligible = await routeableCandidates(key, profileName);
      const concreteAllowlist = key.allowedModels.filter(
        (model) => model.includes('/') && !model.startsWith('ferry/'),
      );
      const hasLogicalAllowlist = key.allowedModels.some(
        (model) => !model.includes('/') && !model.startsWith('ferry/'),
      );
      const concreteModels = eligible.filter((model) =>
        !concreteAllowlist.length && !hasLogicalAllowlist
          ? true
          : concreteAllowlist.includes(model.ref),
      );
      const settings = routingSettings(services);
      const catalogMappings = services.catalog.logicalModels ?? [];
      const mappings = [...catalogMappings, ...settings.logicalModelMappings];
      const logicalNames = [...new Set(mappings.map((mapping) => mapping.logicalName))];
      const availableLogical = logicalNames.filter((name) => {
        if (key.allowedModels.length && !key.allowedModels.includes(name)) return false;
        const resolved = resolveLogicalModelCandidates(
          name,
          eligible,
          catalogMappings,
          settings.logicalModelMappings,
        );
        return resolved.length > 0;
      });
      return [...concreteModels.map((model) => model.ref), ...availableLogical];
    },
    async complete(input) {
      const selectedProfile = input.model.startsWith('@profile:')
        ? input.model.slice('@profile:'.length)
        : input.key.profile;
      const visibleModels = new Set(allModels());
      const candidates = [
        ...services.catalog.models,
        ...services.catalog.providers.flatMap(({ provider }) => services.models.list(provider)),
      ].filter((model) => visibleModels.has(model.ref));
      const runtimeDeps = await import('./session-deps.js');
      const requestDeps = runtimeDeps.createSessionDependencies(services, () => undefined);
      const routed = await routeableCandidates(
        input.key,
        selectedProfile,
        Math.max(1, JSON.stringify(input.messages).length / 4),
      );
      const isProfile = input.model.startsWith('@profile:');
      const logicalMappings = resolveLogicalModelCandidates(
        input.model,
        candidates,
        services.catalog.logicalModels ?? [],
        routingSettings(services).logicalModelMappings,
      );
      const isConfiguredLogical = [
        ...(services.catalog.logicalModels ?? []),
        ...routingSettings(services).logicalModelMappings,
      ].some((mapping) => mapping.logicalName === input.model);
      const logicalRefs = new Set(logicalMappings.map((model) => model.ref));
      const isLogical = !isProfile && isConfiguredLogical;
      if (isLogical && logicalRefs.size === 0)
        throw new Error(`No eligible model is configured for logical name ${input.model}`);
      const explicit = isProfile || isLogical ? undefined : input.model;
      let ordered = isLogical
        ? routed.filter((item) => logicalRefs.has(item.ref))
        : explicit
          ? [
              candidates.find((item) => item.ref === explicit),
              ...routed.filter((item) => item.ref !== explicit),
            ].filter((item): item is (typeof candidates)[number] => Boolean(item))
          : routed;
      const sticky = stickyRoutes.get(input.sessionHint);
      const profileValues = services.settings.get('profiles');
      const selectedProfileRecord = [
        ...BUILTIN_PROFILES,
        ...(Array.isArray(profileValues) ? (profileValues as typeof BUILTIN_PROFILES) : []),
      ].find((entry) => entry.id === profileId(selectedProfile));
      const affinityProviderId =
        sticky?.providerId ?? sticky?.modelRef.slice(0, sticky.modelRef.indexOf('/'));
      const matchesAffinity = (item: (typeof candidates)[number]) => {
        if (!sticky || !affinityProviderId || item.providerId !== affinityProviderId) return false;
        return (
          !sticky.providerKeyId ||
          services.providerKeys.get(item.providerId)?.id === sticky.providerKeyId
        );
      };
      if (!explicit && sticky && sticky.expiresAt > services.clock.now().getTime()) {
        ordered =
          selectedProfileRecord?.affinityMode === 'strict'
            ? ordered.filter(matchesAffinity)
            : [
                ...ordered.filter(matchesAffinity),
                ...ordered.filter((item) => !matchesAffinity(item) && item.ref === sticky.modelRef),
                ...ordered.filter((item) => !matchesAffinity(item) && item.ref !== sticky.modelRef),
              ];
      }
      if (!ordered.length) throw new Error('No eligible provider model is configured');
      let lastError: unknown;
      for (const model of ordered) {
        const providerId = model.providerId;
        const key = await services.secrets.get(providerId);
        if (!key) continue;
        const envName = `FERRY_PROVIDER_BASE_URL_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        const outputState = { started: false };
        try {
          const routedMessages = toGatewayModelMessages(
            compressedMessages(input.messages, input.key.compressToolResults),
          );
          const instructions = [
            input.instructions,
            input.key.terseSystemPrompt ? terseSystemText('Lite') : undefined,
          ]
            .filter((part): part is string => Boolean(part))
            .join('\n\n');
          const result = await streamProviderChat({
            model: model.ref,
            apiKey: key,
            messages: routedMessages,
            ...(instructions ? { system: instructions } : {}),
            ...(input.tools
              ? {
                  tools: input.tools.flatMap((raw) => {
                    if (!raw || typeof raw !== 'object') return [];
                    const item = raw as Record<string, unknown>;
                    if (
                      item.type !== 'function' ||
                      !item.function ||
                      typeof item.function !== 'object'
                    )
                      return [];
                    const fn = item.function as Record<string, unknown>;
                    return typeof fn.name === 'string'
                      ? [
                          {
                            name: fn.name,
                            ...(typeof fn.description === 'string'
                              ? { description: fn.description }
                              : {}),
                            parameters:
                              fn.parameters && typeof fn.parameters === 'object'
                                ? (fn.parameters as Record<string, unknown>)
                                : {},
                          },
                        ]
                      : [];
                  }),
                }
              : {}),
            ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            ...(input.jsonMode ? { jsonMode: true } : {}),
            ...(input.toolChoice === 'auto' ||
            input.toolChoice === 'none' ||
            input.toolChoice === 'required'
              ? { toolChoice: input.toolChoice }
              : input.toolChoice &&
                  typeof input.toolChoice === 'object' &&
                  'function' in input.toolChoice &&
                  input.toolChoice.function &&
                  typeof input.toolChoice.function === 'object' &&
                  'name' in input.toolChoice.function &&
                  typeof input.toolChoice.function.name === 'string'
                ? { toolChoice: { name: input.toolChoice.function.name } }
                : {}),
            ...(services.env[envName] ? { baseUrl: services.env[envName] } : {}),
            overrides: resolveProviderRequestOverrides(
              providerId,
              routingSettings(services).providerOverrides[providerId],
            ),
            fetch: requestDeps.providerFetch,
            onObservation: requestDeps.observe,
            signal: input.signal,
            onText: (delta) => {
              outputState.started = true;
              input.onText?.(delta);
            },
            onToolCall: (call) => {
              outputState.started = true;
              input.onToolCall?.(call);
            },
          });
          const timestamp = services.clock.now().toISOString();
          services.quota.recordUsage({
            id: `gateway:${input.key.id}:${timestamp}`,
            providerId,
            modelRef: model.ref,
            occurredAt: timestamp,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            status: 'success',
          });
          stickyRoutes.set(input.sessionHint, {
            modelRef: model.ref,
            providerId,
            ...(services.providerKeys.get(providerId)?.id
              ? { providerKeyId: services.providerKeys.get(providerId)?.id }
              : {}),
            expiresAt: services.clock.now().getTime() + 30 * 60 * 1000,
          });
          return { id: `gw-${String(Date.now())}`, model: model.ref, ...result };
        } catch (error) {
          const errorName =
            error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
              ? error.name
              : '';
          if (
            /AI_InvalidPromptError|AI_TypeValidationError|AI_NoSuchToolError|ZodError|SchemaValidationError|ValidationError/.test(
              errorName,
            )
          )
            throw error;
          const outer =
            error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
          const providerError =
            outer.name === 'AI_StreamProviderError' &&
            outer.cause &&
            typeof outer.cause === 'object'
              ? (outer.cause as Record<string, unknown>)
              : outer;
          const typed = classifyProviderError({
            status: providerError.status,
            statusCode: providerError.statusCode,
            code: providerError.code,
            type: providerError.type,
            message: providerError.message,
            responseBody: providerError.data ?? providerError.responseBody,
            ...(providerError.response instanceof Response
              ? { headers: providerError.response.headers }
              : {}),
          });
          stickyRoutes.delete(input.sessionHint);
          const rawMessage =
            typed.message || (error instanceof Error ? error.message : 'Provider request failed');
          lastError = new Error(rawMessage.replaceAll(key, '[REDACTED]'));
          const canFallback = typed.scope !== 'none' || typed.retryable;
          if (outputState.started || !canFallback) throw error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('All eligible providers failed before returning output');
    },
  };
  return {
    get status() {
      return handle
        ? {
            running: true,
            port: handle.port,
            host: handle.host,
            url: `http://${handle.host === '0.0.0.0' ? '127.0.0.1' : handle.host}:${String(handle.port)}`,
          }
        : { running: false, port: null, host: null, url: null };
    },
    async start(settings = gatewaySettings(services)) {
      if (handle) return this.status;
      handle = await startGateway({
        runtime,
        port: settings.port,
        allowLan: settings.allowLan,
        allowLanConfirmed: settings.allowLan,
      });
      return this.status;
    },
    async stop() {
      await handle?.close();
      handle = undefined;
      return this.status;
    },
    createKey(name: string, profile: string) {
      const created = createGatewayKey({ name, profile });
      runtime.store.put(created.key);
      return { ...created, key: { ...created.key, hash: undefined } };
    },
    updateKey(
      id: string,
      patch: Partial<
        Pick<
          GatewayKey,
          'profile' | 'allowedModels' | 'rateLimit' | 'compressToolResults' | 'terseSystemPrompt'
        >
      >,
    ) {
      const current = keys(services).find((entry) => entry.id === id);
      if (!current) throw new Error(`Gateway key not found: ${id}`);
      runtime.store.put({ ...current, ...patch });
      return this.listKeys().find((entry) => entry.id === id);
    },
    listKeys() {
      return keys(services).map(({ hash: _hash, ...key }) => ({
        ...key,
        usage: runtime.store.usage(key.id),
      }));
    },
    revokeKey(id: string) {
      const current = keys(services).find((entry) => entry.id === id);
      if (!current) throw new Error(`Gateway key not found: ${id}`);
      runtime.store.put({
        ...current,
        revokedAt: services.clock.now().toISOString(),
      });
    },
    get settings() {
      return gatewaySettings(services);
    },
    async setSettings(settings: GatewaySettings) {
      services.settings.put('gateway-settings', settings);
      if (handle) await this.stop();
      if (settings.enabled) await this.start(settings);
      return { ...settings, status: this.status };
    },
  };
}
