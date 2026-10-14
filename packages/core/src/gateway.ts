import { providerBaseUrl } from './provider-endpoints.js';
import { isOpenCodeAppModel } from '@ferry/shared';
import { zenModel, zenCliMode, zenFerryKey, ZEN_CLI_BASE_URL } from './zen-cli.js';
import { oauthModelCatalog, streamOAuthChat } from '@ferry/oauth';
import { reserveSpend, BudgetError } from './spending.js';
import { withGatewayDeadlines, GatewayTimeoutError } from './gateway-deadlines.js';
import {
  ProviderKeyRotation,
  resolveProviderRequestOverrides,
  streamProviderChat,
} from '@ferry/providers';
import type { ModelMessage } from '@ferry/providers';
import { genericFilter, terseSystemText } from '@ferry/optimizer';
import {
  BUILTIN_PROFILES,
  classifyProviderError,
  resolveLogicalModelCandidates,
  isFreeForRouting,
  calculateSpend,
} from '@ferry/router';
import {
  DIRECT_PROFILE_ID,
  ProfileSchema,
  RoutingSettingsSchema,
  providerDefinition,
  type GatewayRequestRecord,
  type GatewayRoutingExplanation,
  type ModelRef,
} from '@ferry/shared';
import { gatewayHistory, gatewayRequest, gatewayUsageSummary } from './gateway-history.js';
import {
  type GatewayRuntime,
  startGateway,
  createGatewayKey,
  type GatewayKey,
  type GatewayHandle,
  type GatewayMessage,
  type GatewayAttempt,
  type GatewayAttemptState,
  type GatewayCompletion,
} from '@ferry/gateway';
import { randomBytes } from 'node:crypto';
import type { CliCallerTool, CliConversationMessage } from '@ferry/delegate';
import { CliTransportError, isCliTransportError } from '@ferry/delegate';
import { getCliBroker } from './cli-broker.js';
import type { CliConnection, CliModelCapabilities } from '@ferry/shared';
import type { FerryServices } from './services.js';
import { recordRequestFailure, recordRequestSuccess, ledgerKind } from './request-failures.js';
import {
  hasUsableProviderKey,
  recordProviderKeyFailure,
  permitsKeylessProvider,
} from './services.js';
import { getProviderHealth } from './provider-health.js';

interface GatewaySettings {
  enabled: boolean;
  port: number;
  allowLan: boolean;
}
const defaultSettings: GatewaySettings = { enabled: false, port: 11435, allowLan: false };
function keys(services: FerryServices): GatewayKey[] {
  const stored = services.settings.get('gateway-keys');
  return Array.isArray(stored)
    ? (stored as Partial<GatewayKey>[]).map(
        (key) =>
          ({
            ...key,
            paidBackup: key.paidBackup ?? false,
            budgetUsd: key.budgetUsd ?? null,
            tokenLimitPerMinute: key.tokenLimitPerMinute ?? null,
            tokenLimitPerDay: key.tokenLimitPerDay ?? null,
            concurrencyLimit: key.concurrencyLimit ?? null,
          }) as GatewayKey,
      )
    : [];
}
function gatewaySettings(services: FerryServices): GatewaySettings {
  const stored = services.settings.get('gateway-settings');
  return stored && typeof stored === 'object' ? { ...defaultSettings, ...stored } : defaultSettings;
}
interface GatewayUsageState {
  requests: number;
  successfulRequests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  tokenEvents: { at: string; tokens: number }[];
  requestEvents: string[];
}
function gatewayUsage(services: FerryServices, id: string): GatewayUsageState {
  const value = services.settings.get(`gateway-usage:${id}`);
  if (!value || typeof value !== 'object')
    return {
      requests: 0,
      successfulRequests: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      tokenEvents: [],
      requestEvents: [],
    };
  const stored = value as Partial<GatewayUsageState> & { requests?: number };
  return {
    requests: stored.requests ?? 0,
    successfulRequests: stored.successfulRequests ?? stored.requests ?? 0,
    inputTokens: stored.inputTokens ?? 0,
    cachedTokens: stored.cachedTokens ?? 0,
    outputTokens: stored.outputTokens ?? 0,
    tokenEvents: Array.isArray(stored.tokenEvents) ? stored.tokenEvents : [],
    requestEvents: Array.isArray(stored.requestEvents) ? stored.requestEvents : [],
  };
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
          throw Object.assign(new Error('Assistant tool arguments must contain valid JSON.'), {
            code: 'unsupported_request',
            statusCode: 400,
          });
        }
        return [
          { type: 'tool-call' as const, toolCallId: call.id, toolName: call.function.name, input },
        ];
      });
      return [
        ...((typeof message.content === 'string' && message.content) ||
        (Array.isArray(message.content) && message.content.length)
          ? [{ role: 'assistant' as const, content: message.content as never }]
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
              toolName:
                message.name ??
                messages
                  .flatMap((item) => item.tool_calls ?? [])
                  .find((call) => call.id === message.tool_call_id)?.function.name ??
                '',
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
function gatewayCliCode(kind: CliTransportError['kind']): string {
  switch (kind) {
    case 'authentication':
      return 'upstream_credentials';
    case 'exhausted_capacity':
      return 'quota_exhausted';
    case 'timeout':
      return 'request_timeout';
    default:
      return 'unsupported_request';
  }
}

function unsupportedCli(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'unsupported_request',
    statusCode: 400,
  });
}

/** Convert OpenAI-style caller tools into the transport's caller tools (text-only schema). */
export function toCliCallerTools(tools: readonly unknown[] | undefined): CliCallerTool[] {
  return (tools ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    if (item.type !== 'function' || !item.function || typeof item.function !== 'object') return [];
    const fn = item.function as Record<string, unknown>;
    if (typeof fn.name !== 'string' || !fn.name) return [];
    return [
      {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters:
          fn.parameters && typeof fn.parameters === 'object'
            ? (fn.parameters as Record<string, unknown>)
            : {},
      },
    ];
  });
}

/**
 * Convert caller messages into the CLI conversation. Text only for the beta; any image part is
 * rejected before a CLI process is spawned so nothing silently loses content.
 */
export function toCliGatewayMessages(
  messages: readonly GatewayMessage[],
): CliConversationMessage[] {
  const conversation: CliConversationMessage[] = [];
  for (const message of messages) {
    const role = message.role === 'developer' ? 'developer' : message.role;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const record = part as Record<string, unknown>;
          if ('image' in record || 'image_url' in record || record.type === 'image_url')
            throw unsupportedCli(
              'Installed-CLI routes support text only. Remove image input or use the standard API.',
            );
          return typeof record.text === 'string' ? record.text : '';
        })
        .join('');
      if (role === 'assistant') {
        if (message.tool_calls?.length)
          conversation.push({
            role: 'assistant',
            content: text || null,
            tool_calls: message.tool_calls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.function.name, arguments: call.function.arguments },
            })),
          });
        else if (text) conversation.push({ role: 'assistant', content: text });
        continue;
      }
      if (role === 'tool')
        conversation.push({
          role: 'tool',
          content: text,
          ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        });
      else if (text && (role === 'user' || role === 'system' || role === 'developer'))
        conversation.push({ role, content: text });
      continue;
    }
    const content = typeof message.content === 'string' ? message.content : '';
    if (message.role === 'assistant' && message.tool_calls?.length) {
      conversation.push({
        role: 'assistant',
        content: content || null,
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      });
    } else if (message.role === 'tool') {
      conversation.push({
        role: 'tool',
        content,
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      });
    } else if (
      message.role === 'user' ||
      message.role === 'system' ||
      message.role === 'developer' ||
      message.role === 'assistant'
    ) {
      if (content) conversation.push({ role: message.role, content });
    }
  }
  return conversation;
}

/**
 * Route one explicit installed-CLI request through the shared Core broker on the Gateway surface.
 * Text and the CLI's real function tool calls stream to the caller; the caller executes the tools and
 * sends the original results on the next request. Never retried or spliced: a CLI turn is one call.
 */
async function routeCliCompletion(
  services: FerryServices,
  input: Parameters<GatewayRuntime['complete']>[0],
  cli: { connection: CliConnection; model: CliModelCapabilities },
  _requestStarted: number,
): Promise<GatewayCompletion> {
  if (input.jsonMode || input.structuredOutput)
    throw unsupportedCli(
      'Installed-CLI routes support text and caller tools only. Structured output needs the standard API.',
    );
  if (input.parallelToolCalls === true)
    throw unsupportedCli('Installed-CLI routes do not support parallel_tool_calls.');
  if (
    input.toolChoice !== undefined &&
    input.toolChoice !== 'auto' &&
    input.toolChoice !== 'none' &&
    input.toolChoice !== 'required'
  )
    throw unsupportedCli('Installed-CLI routes support tool_choice auto, none or required only.');
  const tools = input.toolChoice === 'none' ? [] : toCliCallerTools(input.tools);
  const messages = toCliGatewayMessages(input.messages);
  const broker = getCliBroker(services, () => undefined);
  const startedAt = Date.now();
  input.onAttempt?.({
    servedModel: cli.model.ref,
    attempts: [{ model: cli.model.ref, status: 'started' }],
  });
  try {
    const { result } = await broker.dispatch({
      surface: 'gateway',
      modelRef: cli.model.ref,
      messages,
      tools,
      signal: input.signal,
      ...(input.effort
        ? { optionOverride: { effort: input.effort, speed: 'standard' as const } }
        : {}),
      onText: (delta) => {
        void input.onText?.(delta);
      },
      inputTokens: Math.ceil(JSON.stringify(input.messages).length / 4),
    });
    for (const call of result.toolCalls)
      await input.onToolCall?.({
        id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    input.onAttempt?.({
      servedModel: cli.model.ref,
      attempts: [
        {
          model: cli.model.ref,
          status: 'served',
          durationMs: Date.now() - startedAt,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          cachedTokens: result.usage.cachedTokens ?? 0,
        },
      ],
    });
    return {
      id: `gw-cli-${String(Date.now())}`,
      model: cli.model.ref,
      responseModel: result.responseModel,
      text: result.text,
      ...(result.toolCalls.length
        ? {
            toolCalls: result.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            })),
          }
        : {}),
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      ...(result.usage.cachedTokens === null ? {} : { cachedTokens: result.usage.cachedTokens }),
      finishReason: result.toolCalls.length ? 'tool_calls' : 'stop',
    };
  } catch (error) {
    if (isCliTransportError(error))
      throw Object.assign(new Error(error.message), {
        statusCode: error.statusCode,
        code: gatewayCliCode(error.kind),
      });
    throw error;
  }
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
function hasConcreteAllowlist(key: GatewayKey): boolean {
  return key.allowedModels.some((ref) => ref.includes('/') && !ref.startsWith('ferry/'));
}
function profileId(raw: string): string {
  if (raw === 'none') return DIRECT_PROFILE_ID;
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

const requestLogLimit = 200;
const controllers = new WeakMap<FerryServices, ReturnType<typeof createGatewayController>>();

export function getGatewayController(services: FerryServices) {
  return controllers.get(services);
}

export function createGatewayController(
  services: FerryServices,
  onRequest?: (record: GatewayRequestRecord) => void,
) {
  let handle: GatewayHandle | undefined;
  let lifecycle = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = lifecycle.then(work);
    lifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const statusNow = () =>
    handle
      ? {
          running: true,
          port: handle.port,
          host: handle.host,
          url: `http://${handle.host === '0.0.0.0' ? '127.0.0.1' : handle.host}:${String(handle.port)}`,
        }
      : { running: false, port: null, host: null, url: null };
  const internalTokens = new Map<
    string,
    { keyId: string; expiresAt: number; testCostCapUsd?: number }
  >();
  // Metadata survives Core restarts; prompt and response content is never stored here.
  const requestLog: GatewayRequestRecord[] = (
    services.db.client
      .prepare('SELECT data_json FROM gateway_requests ORDER BY at DESC LIMIT ?')
      .all(requestLogLimit) as { data_json: string }[]
  ).map((row) => JSON.parse(row.data_json) as GatewayRequestRecord);
  const logRequest = (record: GatewayRequestRecord) => {
    if (!services.db.client.open) return;
    services.db.client
      .prepare('INSERT OR REPLACE INTO gateway_requests(id,at,data_json) VALUES(?,?,?)')
      .run(record.id, record.at, JSON.stringify(record));
    requestLog.unshift(record);
    requestLog.splice(requestLogLimit);
    onRequest?.(record);
  };
  const providerKeyRotation = new ProviderKeyRotation();
  const health = getProviderHealth(services);
  const stickyRoutes = new Map<
    string,
    {
      modelRef: string;
      providerId?: string | undefined;
      providerKeyId?: string | undefined;
      expiresAt: number;
    }
  >();
  const availableModels = () => [
    ...services.catalog.providers.flatMap(({ provider }) =>
      services.models.list(provider).map((model) => zenModel(services, model)),
    ),
    ...((services.settings.get('global') as { allowSubscriptionOAuthRouting?: boolean } | undefined)
      ?.allowSubscriptionOAuthRouting
      ? oauthModelCatalog
      : []),
  ];
  const allModels = (models = availableModels()) => {
    const providerStates = new Map<string, ReturnType<typeof services.providers.get>>();
    const credentialStates = new Map<string, boolean>();
    const configuredById = new Map(
      services.catalog.providers.map((entry) => [entry.provider, entry]),
    );
    return models
      .filter((model) => !isOpenCodeAppModel(model))
      .filter((model) => {
        if (!providerStates.has(model.providerId))
          providerStates.set(model.providerId, services.providers.get(model.providerId));
        const saved = providerStates.get(model.providerId);
        const definition = providerDefinition(model.providerId);
        if (
          definition?.releaseState === 'Coming soon' ||
          (definition?.releaseState === 'Beta' && saved?.enabled !== true)
        )
          return false;
        const configured = configuredById.get(model.providerId);
        if (!credentialStates.has(model.providerId))
          credentialStates.set(model.providerId, hasUsableProviderKey(services, model.providerId));
        const availableCredentials =
          credentialStates.get(model.providerId) === true ||
          configured?.key_required === false ||
          (model.providerId.startsWith('oauth-') && saved?.keyStatus === 'valid');
        return (
          (saved?.enabled ?? availableCredentials) &&
          availableCredentials &&
          health.tracker.available(model.providerId, model.ref) &&
          !saved?.excludedModelRefs?.includes(model.ref)
        );
      })
      .map((model) => model.ref);
  };
  const routeableCandidates = async (
    key: GatewayKey,
    profileName: string,
    inputTokens = 1,
    requiresTools = false,
  ) => {
    const allowedConcrete = key.allowedModels.filter(
      (ref) => ref.includes('/') && !ref.startsWith('ferry/'),
    );
    if (profileName === 'none' && allowedConcrete.length > 0) {
      const candidates = [...availableModels()];
      const byRef = new Map(candidates.map((model) => [model.ref, model]));
      const visible = new Set(allModels(candidates));
      return allowedConcrete.flatMap((ref) => {
        const model = byRef.get(ref as (typeof candidates)[number]['ref']);
        return model && visible.has(model.ref) ? [model] : [];
      });
    }
    const allProfiles = [...BUILTIN_PROFILES];
    const custom = services.settings.get('profiles');
    if (Array.isArray(custom)) allProfiles.push(...(custom as typeof BUILTIN_PROFILES));
    const overrides =
      ProfileSchema.array().safeParse(services.settings.get('profile-overrides')).data ?? [];
    const base = allProfiles.find((entry) => entry.id === profileId(profileName));
    const selected = base
      ? {
          ...base,
          ...(overrides.some((item) => item.id === base.id)
            ? {
                fallbackChain:
                  overrides.find((item) => item.id === base.id)?.fallbackChain ??
                  base.fallbackChain,
                roles: overrides.find((item) => item.id === base.id)?.roles ?? base.roles,
              }
            : {}),
        }
      : undefined;
    if (!selected) return [];
    const effective =
      selected.id === 'profile_builtin_auto_free' && key.paidBackup && (key.budgetUsd ?? 0) > 0
        ? { ...selected, paidAllowed: true, allowedProviders: 'all' as const }
        : selected;
    const runtimeDeps = await import('./session-deps.js');
    const requestDeps = runtimeDeps.createSessionDependencies(services, () => undefined);
    const eligible = requestDeps.gateway.resolveCandidates(
      effective,
      requiresTools ? 'edit' : 'plan',
      inputTokens,
      requiresTools,
    );
    return allowedConcrete.length
      ? allowedConcrete.flatMap((ref) => {
          const model = eligible.find((item) => item.ref === ref);
          return model ? [model] : [];
        })
      : eligible;
  };
  const runtime: GatewayRuntime = {
    async inputTokenBound(key, model) {
      const requested = model.startsWith('@profile:')
        ? model.slice('@profile:'.length)
        : key.profile;
      const assigned = new Set(
        (await routeableCandidates(key, key.profile)).map((model) => model.ref),
      );
      return Math.max(
        0,
        ...(await routeableCandidates(key, requested))
          .filter((model) => assigned.has(model.ref) && model.capability?.vision === true)
          .map((model) => model.contextWindow),
      );
    },
    unavailable(key) {
      const connected = services.providers.list().filter((provider) => provider.enabled);
      if (connected.some((provider) => provider.keyStatus === 'invalid'))
        return {
          code: 'upstream_credentials',
          statusCode: 401,
          message: 'Replace the invalid upstream provider credentials in Models.',
        };
      if (
        connected.some(
          (provider) =>
            provider.health === 'cooldown' ||
            provider.health === 'down' ||
            !!provider.pausedReason ||
            !health.tracker.available(provider.id) ||
            services.models
              .list(provider.id)
              .some(
                (model) =>
                  services.quota.health(provider.id, model.ref, provider.id).health !== 'ok',
              ),
        )
      )
        return {
          code: 'quota_exhausted',
          statusCode: 429,
          message:
            'Eligible providers are unavailable or cooling down. Review Models → Health and quota resets.',
        };
      const models = availableModels();
      const visible = new Set(allModels(models));
      if (
        !key.paidBackup &&
        models.some((model) => visible.has(model.ref) && (model.priceInPerM ?? 0) > 0)
      )
        return {
          code: 'budget_exhausted',
          statusCode: 402,
          message:
            'No route fits this free-only policy. Connect a free provider or explicitly authorize paid backup with a spending cap.',
        };
      return {
        code: 'unsupported_request',
        statusCode: 400,
        message:
          'No model fits this key and preset. Connect an eligible provider or review routing restrictions.',
      };
    },
    rejected(input) {
      logRequest({
        id: input.traceId,
        at: input.at,
        keyId: input.key.id,
        keyName: input.key.name,
        requestedModel: 'Not dispatched (queue admission)',
        traceId: input.traceId,
        modelRef: null,
        providerId: null,
        status: 'error',
        outcome: input.code === 'cancelled' ? 'cancelled' : 'failed',
        attempts: [],
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: input.durationMs,
        firstResponseMs: null,
        queueWaitMs: input.durationMs,
        costUsd: 0,
        estimatedCost: false,
        error:
          input.code === 'queue_full'
            ? 'Gateway queue full. Retry shortly.'
            : 'Cancelled or stopped before dispatch.',
        constraints: ['Not dispatched; request body and content were not read.'],
      });
    },
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
      recordRequest: (id, _at) => {
        const current = gatewayUsage(services, id);
        const requestEvents = current.requestEvents.filter(
          (at) => Date.parse(_at) - Date.parse(at) < 86_400_000,
        );
        requestEvents.push(_at);
        services.settings.put(`gateway-usage:${id}`, {
          ...current,
          requests: current.requests + 1,
          requestEvents,
        });
      },
      recentRequests: (id, now) =>
        gatewayUsage(services, id).requestEvents.filter(
          (at) => Date.parse(now) - Date.parse(at) < 60_000,
        ).length,
      usage: (id) => {
        const { requests, successfulRequests, inputTokens, outputTokens } = gatewayUsage(
          services,
          id,
        );
        return { requests, successfulRequests, inputTokens, outputTokens };
      },
      tokenUsage: (id, now) => {
        const state = gatewayUsage(services, id);
        const timestamp = Date.parse(now);
        const day = now.slice(0, 10);
        const minuteTokens = state.tokenEvents
          .filter((event) => timestamp - Date.parse(event.at) < 60_000)
          .reduce((sum, event) => sum + event.tokens, 0);
        const dayTokens = state.tokenEvents
          .filter((event) => event.at.slice(0, 10) === day)
          .reduce((sum, event) => sum + event.tokens, 0);
        return { minuteTokens, dayTokens };
      },
      recordUsage: (id, inputTokens, outputTokens, at, cachedTokens = 0) => {
        const current = gatewayUsage(services, id);
        const tokenEvents = current.tokenEvents.filter(
          (event) => Date.parse(at) - Date.parse(event.at) < 86_400_000,
        );
        tokenEvents.push({ at, tokens: inputTokens + outputTokens });
        services.settings.put(`gateway-usage:${id}`, {
          ...current,
          successfulRequests: current.successfulRequests + 1,
          inputTokens: current.inputTokens + inputTokens,
          outputTokens: current.outputTokens + outputTokens,
          cachedTokens: current.cachedTokens + cachedTokens,
          tokenEvents,
        });
      },
    },
    async models(key, profileName = key.profile) {
      const assigned = new Set(
        (await routeableCandidates(key, key.profile)).map((model) => model.ref),
      );
      const eligible = (await routeableCandidates(key, profileName)).filter((model) =>
        assigned.has(model.ref),
      );
      // Gateway-eligible installed-CLI models are explicit direct-connection refs. They are listed
      // (and pass the explicit-model admission check) once the Gateway surface is opted in; the
      // broker then enforces verification, identity and billing before any dispatch. They never
      // enter profile/Auto routing.
      const cliRefs = getCliBroker(services, () => undefined)
        .connections()
        .filter((connection) => connection.surfaces.gateway)
        .flatMap((connection) =>
          connection.models.filter((model) => !model.hidden).map((model) => model.ref),
        )
        .filter((ref) => !key.allowedModels.length || key.allowedModels.includes(ref));
      const concreteAllowlist = key.allowedModels.filter(
        (model) => model.includes('/') && !model.startsWith('ferry/'),
      );
      if (key.profile === 'none' && concreteAllowlist.length > 0)
        return [...new Set([...eligible.map((model) => model.ref), ...cliRefs])];
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
      return [
        ...new Set([...concreteModels.map((model) => model.ref), ...availableLogical, ...cliRefs]),
      ];
    },
    async complete(input) {
      const started = input.receivedAt ? new Date(input.receivedAt) : services.clock.now();
      const base = {
        id: `gwreq_${String(started.getTime())}_${Math.random().toString(36).slice(2, 8)}`,
        at: started.toISOString(),
        keyId: input.key.id,
        keyName: input.key.name,
        requestedModel:
          input.requestedModel ??
          (input.model.startsWith('@profile:')
            ? `ferry/${input.model.slice('@profile:'.length)}`
            : input.model),
      };
      const traceId = input.traceId ?? base.id;
      const attemptState: GatewayAttemptState = { servedModel: '', attempts: [] };
      const onAttempt = (state: GatewayAttemptState) => {
        attemptState.servedModel = state.servedModel;
        attemptState.attempts = state.attempts;
        input.onAttempt?.(state);
      };
      const latencyMs = () => Math.max(0, services.clock.now().getTime() - started.getTime());
      let firstResponseMs: number | null = null;
      const outputState = { visible: false };
      const progress = () => {
        firstResponseMs ??= latencyMs();
      };
      const constraints = [
        `Assigned preset: ${input.key.profile}`,
        input.key.paidBackup
          ? `Paid backup: monthly key cap $${String(input.key.budgetUsd)}; profile and global caps also apply.`
          : 'Free only; paid routing disabled.',
        input.key.allowedModels.length
          ? `Restricted to ${input.key.allowedModels.join(', ')}`
          : 'All models allowed by assigned policy.',
        input.tools?.length ? 'Requires native tool calls.' : 'Text request.',
        'Context includes conversation, tools and requested output. Prompts and responses are excluded from history.',
      ];
      const cost = () => {
        if (!services.db.client.open) return { costUsd: null, estimatedCost: true };
        const row = services.db.client
          .prepare(
            'SELECT sum(amount_usd) AS amount, max(estimated) AS estimated FROM spend_charges WHERE id LIKE ?',
          )
          .get(`${base.id}:%`) as { amount: number | null; estimated: number | null };
        return { costUsd: row.amount ?? 0, estimatedCost: row.estimated === 1 };
      };
      const reserveUnreportedTokens = () => {
        const usage = gatewayUsage(services, input.key.id);
        const at = services.clock.now().toISOString();
        services.settings.put(`gateway-usage:${input.key.id}`, {
          ...usage,
          tokenEvents: [
            ...usage.tokenEvents.filter(
              (event) => Date.parse(at) - Date.parse(event.at) < 86_400_000,
            ),
            {
              at,
              tokens:
                Buffer.byteLength(
                  JSON.stringify(input.messages) +
                    JSON.stringify(input.tools ?? []) +
                    (input.instructions ?? ''),
                  'utf8',
                ) + (input.maxTokens ?? 4096),
            },
          ],
        });
      };
      try {
        const result = await routeCompletion(
          {
            ...input,
            traceId,
            onAttempt,
            onText: async (delta) => {
              progress();
              if (input.onText) {
                outputState.visible = true;
                await input.onText(delta);
              }
            },
            onToolCall: async (call) => {
              progress();
              if (input.onToolCall) {
                outputState.visible = true;
                await input.onToolCall(call);
              }
            },
          },
          base.id,
          () => outputState.visible,
        );
        const usageReported = result.inputTokens > 0 || result.outputTokens > 0;
        if (!usageReported) reserveUnreportedTokens();
        logRequest({
          ...base,
          traceId,
          modelRef: result.model,
          servedModel: result.model,
          attempts: result.attempts ?? attemptState.attempts,
          providerId: result.model.includes('/')
            ? result.model.slice(0, result.model.indexOf('/'))
            : null,
          status: 'ok',
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: latencyMs(),
          error: null,
          outcome: 'completed',
          firstResponseMs,
          queueWaitMs: input.queueWaitMs ?? 0,
          usageReported,
          cachedTokens: result.cachedTokens ?? 0,
          ...cost(),
          constraints,
        });
        return { ...result, traceId, attempts: result.attempts ?? attemptState.attempts };
      } catch (error) {
        if (
          attemptState.attempts.some(
            (attempt) => attempt.status === 'failed' || attempt.status === 'served',
          )
        )
          reserveUnreportedTokens();
        logRequest({
          ...base,
          traceId,
          modelRef: null,
          servedModel:
            outputState.visible || attemptState.attempts.at(-1)?.status === 'served'
              ? attemptState.servedModel
              : null,
          attempts: attemptState.attempts,
          providerId: outputState.visible ? (attemptState.servedModel.split('/')[0] ?? null) : null,
          status: 'error',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: latencyMs(),
          error:
            error instanceof BudgetError
              ? 'Spending policy blocked this request. Check key, preset and global limits.'
              : input.signal.aborted
                ? 'Request cancelled or its deadline expired.'
                : 'Upstream request failed. Review the attempted routes and provider health. Request content is excluded from diagnostics.',
          outcome: outputState.visible ? 'partial' : input.signal.aborted ? 'cancelled' : 'failed',
          firstResponseMs,
          queueWaitMs: input.queueWaitMs ?? 0,
          usageReported: false,
          ...cost(),
          constraints,
        });
        throw error;
      }
    },
  };
  async function routeCompletion(
    input: Parameters<GatewayRuntime['complete']>[0],
    ledgerRequestId: string,
    hasVisibleOutput: () => boolean,
  ): ReturnType<GatewayRuntime['complete']> {
    const requestStarted = Date.now();
    // An explicit installed-CLI model is a direct connection: same Core broker, same admission
    // policy and the original caller tool calls returned for execution on the caller side.
    if (!input.model.startsWith('@profile:')) {
      const cli = getCliBroker(services, () => undefined).model(input.model as ModelRef);
      if (cli) return await routeCliCompletion(services, input, cli, requestStarted);
    }
    const selectedProfile = input.model.startsWith('@profile:')
      ? input.model.slice('@profile:'.length)
      : input.key.profile;
    const visibleModels = new Set(allModels());
    const candidates = [...availableModels()].filter((model) => visibleModels.has(model.ref));
    const runtimeDeps = await import('./session-deps.js');
    const requestDeps = runtimeDeps.createSessionDependencies(services, () => undefined);
    const routed = await routeableCandidates(
      input.key,
      selectedProfile,
      Math.max(1, JSON.stringify(input.messages).length / 4),
      !!input.tools?.length,
    );
    const keyEligible = new Set(
      (
        await routeableCandidates(
          input.key,
          input.key.profile,
          Math.max(1, JSON.stringify(input.messages).length / 4),
          !!input.tools?.length,
        )
      ).map((model) => model.ref),
    );
    const requestedEligible = new Set(routed.map((model) => model.ref));
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
            // A "No profile" key with picked models only ever routes inside that list.
            input.key.profile === 'none' && hasConcreteAllowlist(input.key)
              ? routed.find((item) => item.ref === explicit)
              : candidates.find((item) => item.ref === explicit),
            ...routed.filter((item) => item.ref !== explicit),
          ].filter((item): item is (typeof candidates)[number] => Boolean(item))
        : routed;
    ordered = ordered.filter(
      (model) =>
        keyEligible.has(model.ref) &&
        requestedEligible.has(model.ref) &&
        (!hasConcreteAllowlist(input.key) || input.key.allowedModels.includes(model.ref)),
    );
    if (input.requestedModel === 'ferry/auto-free') {
      const providers = requestDeps.providers();
      ordered = ordered.filter((model) => {
        const provider = providers.find((provider) => provider.id === model.providerId);
        return (
          !!provider &&
          isFreeForRouting(provider, model, routingSettings(services).trialOptInProviders)
        );
      });
    }
    if (input.tools?.length)
      ordered = ordered.filter(
        (model) => model.toolCalling && model.capability?.toolCall !== false,
      );
    const effort = input.effort;
    if (effort) ordered = ordered.filter((model) => model.reasoningEfforts?.includes(effort));
    const containsImage = input.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) =>
          Boolean(part && typeof part === 'object' && ('image' in part || 'image_url' in part)),
        ),
    );
    if (containsImage) {
      ordered = ordered.filter((candidate) => candidate.capability?.vision === true);
      if (!ordered.length)
        throw Object.assign(new Error('No eligible upstream model supports image input'), {
          name: 'AI_InvalidPromptError',
        });
    }
    const sticky = stickyRoutes.get(input.sessionHint);
    const profileValues = services.settings.get('profiles');
    const selectedProfileRecord = [
      ...BUILTIN_PROFILES,
      ...(Array.isArray(profileValues) ? (profileValues as typeof BUILTIN_PROFILES) : []),
    ].find((entry) => entry.id === profileId(selectedProfile));
    const keyProfileRecord = [
      ...BUILTIN_PROFILES,
      ...(Array.isArray(profileValues) ? (profileValues as typeof BUILTIN_PROFILES) : []),
    ].find((entry) => entry.id === profileId(input.key.profile));
    const tightest = (a: number | null | undefined, b: number | null | undefined) =>
      a == null ? (b ?? null) : b == null ? a : Math.min(a, b);
    const affinityProviderId =
      sticky?.providerId ?? sticky?.modelRef.slice(0, sticky.modelRef.indexOf('/'));
    const matchesAffinity = (item: (typeof candidates)[number]) => {
      if (!sticky || !affinityProviderId || item.providerId !== affinityProviderId) return false;
      return (
        !sticky.providerKeyId ||
        services.providerKeyEntries
          .list(item.providerId)
          .some((entry) => entry.id === sticky.providerKeyId)
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
    if (!ordered.length)
      throw Object.assign(
        new Error(
          'No upstream model meets this key, profile and capability policy. Connect a provider or choose a supported request.',
        ),
        { code: 'unsupported_request', statusCode: 400 },
      );
    let lastError: unknown;
    const now = services.clock.now().getTime();
    const withKeyFallback = ordered.flatMap((model) => {
      if (permitsKeylessProvider(services, model.providerId)) return [model];
      const count = services.providerKeyEntries
        .list(model.providerId)
        .filter(
          (key) =>
            key.enabled &&
            key.status !== 'invalid' &&
            (key.status !== 'disabled' ||
              Boolean(key.cooldownUntil && Date.parse(key.cooldownUntil) <= now)) &&
            (key.status !== 'rate_limited' ||
              !key.cooldownUntil ||
              Date.parse(key.cooldownUntil) <= now),
        ).length;
      return Array.from({ length: Math.max(1, count) }, () => model);
    });
    const lastAttemptHistory: GatewayAttempt[] = [];
    for (const model of withKeyFallback.slice(0, 5)) {
      input.signal.throwIfAborted();
      const remainingMs = 150_000 - (Date.now() - requestStarted);
      if (remainingMs <= 0) throw new GatewayTimeoutError('Gateway request deadline reached.');
      if (services.providers.get(model.providerId)?.enabled === false) {
        lastAttemptHistory.push({
          model: model.ref,
          status: 'skipped',
          reason: 'Provider disabled or paused.',
        });
        continue;
      }
      const providerId = model.providerId;
      if (!health.tracker.available(providerId, model.ref)) {
        lastAttemptHistory.push({
          model: model.ref,
          status: 'skipped',
          reason: 'Provider or model cooldown.',
        });
        continue;
      }
      const cliTransport = providerId === 'opencode' && model.free && zenCliMode(services);
      const entries = cliTransport ? [] : services.providerKeyEntries.list(providerId);
      if (!entries.length && !health.tracker.available(providerId, model.ref, providerId)) continue;
      const stickyKeyId = stickyRoutes.get(input.sessionHint)?.providerKeyId;
      const preferredKeyId =
        stickyKeyId &&
        !entries.some((entry) => entry.id === stickyKeyId) &&
        services.providerKeys.get(providerId)?.id === stickyKeyId
          ? entries.find((entry) => entry.position === 0)?.id
          : stickyKeyId;
      const providerKey = providerKeyRotation.select(
        providerId,
        entries
          .filter((entry) => health.tracker.available(providerId, model.ref, entry.id))
          .map((entry) => ({ ...entry, order: entry.position })),
        services.clock.now(),
        'round_robin',
        preferredKeyId,
      );
      const oauth = oauthModelCatalog.some((entry) => entry.ref === model.ref);
      const legacyKeyRef = services.providerKeys.get(providerId)?.keyringRef;
      const key = cliTransport
        ? await zenFerryKey(services)
        : providerKey
          ? await services.secrets.get(providerKey.keyringRef)
          : services.providerKeyEntries.list(providerId).length === 0 && legacyKeyRef
            ? await services.secrets.get(legacyKeyRef)
            : undefined;
      input.signal.throwIfAborted();
      if (!key && !permitsKeylessProvider(services, providerId) && !oauth) {
        lastError = Object.assign(
          new Error(`Connect or replace the upstream credentials for ${providerId}.`),
          { code: 'upstream_credentials', statusCode: 401 },
        );
        continue;
      }
      const baseUrl =
        providerId === 'opencode' && model.free && zenCliMode(services)
          ? ZEN_CLI_BASE_URL
          : providerBaseUrl(services, providerId);
      const attemptStarted = Date.now();
      const attempts = lastAttemptHistory;
      attempts.push({ model: model.ref, status: 'started' });
      input.onAttempt?.({ servedModel: model.ref, attempts: [...attempts] });
      if (providerKey) requestDeps.associateObservationKey(providerId, providerKey.id);
      let reservation: ReturnType<typeof reserveSpend> | undefined;
      try {
        const providers = requestDeps.providers();
        const provider = providers.find((entry) => entry.id === providerId);
        const free =
          provider &&
          isFreeForRouting(provider, model, routingSettings(services).trialOptInProviders);
        const outputTokens = Math.min(input.maxTokens ?? model.maxOutput, model.maxOutput);
        const inputTokens = Buffer.byteLength(
          JSON.stringify(input.messages) +
            JSON.stringify(input.tools ?? []) +
            (input.instructions ?? ''),
          'utf8',
        );
        if (inputTokens + outputTokens > model.contextWindow)
          throw Object.assign(
            new Error('Conversation and requested output exceed the selected model context.'),
            { code: 'unsupported_request', statusCode: 400 },
          );
        if (!free) {
          if (!input.key.paidBackup || !input.key.budgetUsd || input.key.budgetUsd <= 0)
            throw new BudgetError(
              'Paid execution requires this key’s explicit paid-backup policy and a positive dollar limit.',
            );
          if (!oauth && (model.priceInPerM === null || model.priceOutPerM === null))
            throw new BudgetError(
              'Automatic paid routing is blocked because this model’s pricing is unknown. Choose a model with published pricing.',
            );
          const billedInputTokens = containsImage
            ? Math.max(inputTokens, model.contextWindow - outputTokens)
            : inputTokens;
          const amountUsd = oauth
            ? 0
            : (billedInputTokens * Math.max(model.priceInPerM ?? 0, model.priceCachedInPerM ?? 0) +
                outputTokens * (model.priceOutPerM ?? 0)) /
              1_000_000;
          if (input.key.requestCostCapUsd !== undefined) {
            const previous = services.db.client
              .prepare(
                'SELECT coalesce(sum(amount_usd),0) AS spent FROM spend_charges WHERE id LIKE ?',
              )
              .get(`${ledgerRequestId}:%`) as { spent: number };
            if (previous.spent + amountUsd > input.key.requestCostCapUsd)
              throw new BudgetError(
                'This verification request would exceed its approved test cost ceiling.',
              );
          }
          const global = services.settings.get('global') as
            | {
                paidCaps?: {
                  sessionUsd: number | null;
                  dailyUsd: number | null;
                  monthlyUsd: number | null;
                };
              }
            | undefined;
          reservation = reserveSpend(services, {
            id: `${ledgerRequestId}:${String(attempts.length)}`,
            keyId: input.key.id,
            profileId: profileId(input.key.profile),
            sessionId: input.sessionHint || input.key.id,
            amountUsd,
            keyCaps: { sessionUsd: null, dailyUsd: null, monthlyUsd: input.key.budgetUsd },
            profileCaps: {
              sessionUsd: tightest(
                keyProfileRecord?.caps.sessionUsd,
                selectedProfileRecord?.caps.sessionUsd,
              ),
              dailyUsd: tightest(
                keyProfileRecord?.caps.dailyUsd,
                selectedProfileRecord?.caps.dailyUsd,
              ),
              monthlyUsd: tightest(
                keyProfileRecord?.caps.monthlyUsd,
                selectedProfileRecord?.caps.monthlyUsd,
              ),
            },
            globalCaps: global?.paidCaps ?? { sessionUsd: null, dailyUsd: null, monthlyUsd: null },
          });
        }
        const startedAt = services.clock.now().getTime();
        const routedMessages = toGatewayModelMessages(
          compressedMessages(input.messages, input.key.compressToolResults),
        );
        const instructions = [
          input.instructions,
          input.key.terseSystemPrompt ? terseSystemText('Lite') : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join('\n\n');
        const result = await withGatewayDeadlines(
          {
            signal: input.signal,
            firstResponseMs: routingSettings(services).firstTokenTimeoutSeconds * 1000,
            idleMs: Number(services.env.FERRY_STEP_TIMEOUT_MS) || 120_000,
            overallMs: remainingMs,
          },
          async (signal, progress) => {
            requestDeps.setProviderProgress(progress);
            const chatInput = {
              model: model.ref,
              modelInfo: model,
              ...(input.effort ? { effort: input.effort } : {}),
              apiKey: key ?? '',
              sessionId: input.sessionHint,
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
              maxTokens: outputTokens,
              ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
              ...(input.jsonMode ? { jsonMode: true } : {}),
              ...(input.structuredOutput ? { structuredOutput: input.structuredOutput } : {}),
              ...(input.parallelToolCalls === undefined
                ? {}
                : { parallelToolCalls: input.parallelToolCalls }),
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
              ...(baseUrl ? { baseUrl } : {}),
              overrides: resolveProviderRequestOverrides(
                providerId,
                routingSettings(services).providerOverrides[providerId],
              ),
              fetch: requestDeps.providerFetch,
              onObservation: requestDeps.observe,
              signal,
              onProgress: progress,
              onText: async (delta: string) => {
                if (signal.aborted) return;
                await input.onText?.(delta);
              },
              onToolCall: async (call: { id: string; name: string; arguments: string }) => {
                if (signal.aborted) return;
                await input.onToolCall?.(call);
              },
            } satisfies Parameters<typeof streamProviderChat>[0];
            if (oauth) {
              if (
                input.jsonMode ||
                input.structuredOutput ||
                (input.toolChoice && input.toolChoice !== 'auto') ||
                input.parallelToolCalls !== undefined
              )
                throw Object.assign(
                  new Error(
                    'This OAuth adapter does not support the requested structured-output or tool-choice controls.',
                  ),
                  { code: 'unsupported_request', statusCode: 400 },
                );
              return streamOAuthChat(services.secrets, {
                ...chatInput,
                model,
                messages: input.messages,
              });
            }
            return streamProviderChat(chatInput);
          },
        );
        const timestamp = services.clock.now().toISOString();
        health.record({
          providerId,
          modelRef: model.ref,
          keyId: providerKey?.id ?? providerId,
          success: true,
          latencyMs: services.clock.now().getTime() - startedAt,
        });
        if (providerKey)
          services.providerKeyUsage.record(
            providerId,
            providerKey.keyId,
            new Date(timestamp),
            result.inputTokens,
            result.outputTokens,
          );
        const usageMissing =
          !free && !oauth && result.inputTokens === 0 && result.outputTokens === 0;
        const chargedUsd =
          free || oauth
            ? 0
            : usageMissing
              ? (reservation?.estimatedUsd ?? 0)
              : calculateSpend(
                  {
                    inputTokens: result.inputTokens,
                    outputTokens: result.outputTokens,
                    cachedTokens: result.cachedTokens ?? 0,
                  },
                  model,
                );
        services.quota.recordUsage({
          id: reservation?.id ?? `gateway:${input.key.id}:${timestamp}`,
          costUsd: chargedUsd,
          providerId,
          modelRef: model.ref,
          occurredAt: timestamp,
          inputTokens: result.inputTokens,
          ...(result.cachedTokens === undefined ? {} : { cachedTokens: result.cachedTokens }),
          outputTokens: result.outputTokens,
          status: 'success',
        });
        reservation?.settle(chargedUsd, usageMissing, true);
        stickyRoutes.set(input.sessionHint, {
          modelRef: model.ref,
          providerId,
          ...(providerKey?.id ? { providerKeyId: providerKey.id } : {}),
          expiresAt: services.clock.now().getTime() + 30 * 60 * 1000,
        });
        recordRequestSuccess(services, providerId, model.ref);
        attempts[attempts.length - 1] = {
          model: model.ref,
          status: 'served',
          durationMs: Date.now() - attemptStarted,
          costUsd: chargedUsd,
          estimatedCost: usageMissing,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedTokens: result.cachedTokens ?? 0,
        };
        input.onAttempt?.({ servedModel: model.ref, attempts: [...attempts] });
        return {
          id: `gw-${String(Date.now())}`,
          model: model.ref,
          ...result,
          ...(input.traceId ? { traceId: input.traceId } : {}),
          attempts,
        };
      } catch (error) {
        reservation?.settle();
        if (
          error instanceof BudgetError ||
          (error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'unsupported_request')
        ) {
          attempts[attempts.length - 1] = {
            model: model.ref,
            status: 'skipped',
            reason: error instanceof Error ? error.message : 'Policy constraint',
            durationMs: Date.now() - attemptStarted,
          };
          input.onAttempt?.({ servedModel: model.ref, attempts: [...attempts] });
          lastError = error;
          continue;
        }
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
        const outer = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
        const providerError =
          outer.name === 'AI_StreamProviderError' && outer.cause && typeof outer.cause === 'object'
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
        recordRequestFailure(services, {
          providerId,
          modelRef: model.ref,
          keyId: providerKey?.id ?? null,
          requestId: ledgerRequestId,
          sessionId: input.sessionHint || null,
          source: 'gateway',
          kind: input.signal.aborted
            ? 'cancelled'
            : ledgerKind(typed.family, typed.status, typed.message),
          statusCode: typed.status,
          message: `${typed.family}; upstream HTTP ${String(typed.status ?? 'unknown')}. Request content is excluded.`,
        });
        attempts[attempts.length - 1] = {
          model: model.ref,
          status: 'failed',
          reason: typed.family,
          durationMs: Date.now() - attemptStarted,
          costUsd: reservation?.estimatedUsd ?? 0,
          estimatedCost: !!reservation,
        };
        input.onAttempt?.({ servedModel: model.ref, attempts: [...attempts] });
        const providerStatus = Number(
          providerError.statusCode ??
            providerError.status ??
            (providerError.response && typeof providerError.response === 'object'
              ? (providerError.response as { status?: unknown }).status
              : 0),
        );
        const responseHeaders = providerError.responseHeaders;
        const retryAfter =
          providerError.response instanceof Response
            ? (providerError.response.headers.get('retry-after') ?? undefined)
            : responseHeaders &&
                typeof responseHeaders === 'object' &&
                'retry-after' in responseHeaders
              ? String(responseHeaders['retry-after'])
              : undefined;
        if (!input.signal.aborted)
          health.record({
            providerId,
            modelRef: model.ref,
            keyId: providerKey?.id ?? providerId,
            success: false,
            status: providerStatus,
            message: typed.message,
            retryAfter,
          });
        if (providerKey)
          recordProviderKeyFailure(
            services,
            providerKey,
            providerStatus,
            typed.message,
            retryAfter,
          );
        if (
          providerStatus === 404 ||
          /model_not_found/i.test(typed.message) ||
          (providerStatus === 400 && /model.{0,60}not supported/i.test(typed.message))
        ) {
          const saved = services.providers.get(providerId);
          if (saved)
            services.providers.put({
              ...saved,
              excludedModelRefs: [...new Set([...(saved.excludedModelRefs ?? []), model.ref])],
            });
        }
        stickyRoutes.delete(input.sessionHint);
        const rawMessage =
          typed.message || (error instanceof Error ? error.message : 'Provider request failed');
        lastError =
          error instanceof GatewayTimeoutError
            ? error
            : Object.assign(
                new Error(key ? rawMessage.replaceAll(key, '[REDACTED]') : rawMessage),
                {
                  statusCode: providerStatus >= 400 ? providerStatus : 502,
                  ...(providerStatus === 401 || providerStatus === 403
                    ? { code: 'upstream_credentials' }
                    : providerStatus === 429
                      ? { code: 'quota_exhausted' }
                      : {}),
                },
              );
        const canFallback = typed.scope !== 'none' || typed.retryable;
        if (input.signal.aborted || hasVisibleOutput() || !canFallback) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('All eligible providers failed before returning output');
  }
  const controller = {
    history: (input: import('@ferry/shared').GatewayHistoryQuery = {}) =>
      gatewayHistory(services, input),
    request: (id: string) => gatewayRequest(services, id),
    usage: (
      range: import('@ferry/shared').GatewayHistoryQuery['range'],
      groupBy: 'key' | 'provider' | 'model',
    ) => gatewayUsageSummary(services, range, groupBy),
    activity: () => handle?.activity() ?? { active: 0, queued: 0 },
    async routing(keyId?: string): Promise<GatewayRoutingExplanation> {
      const key = keyId
        ? keys(services).find((key) => key.id === keyId && !key.revokedAt)
        : keys(services).find((key) => !key.revokedAt);
      const policy = key ?? createGatewayKey({ name: 'Readiness', profile: 'auto-free' }).key;
      if (keyId && !key) throw new Error('Unknown or revoked Gateway key.');
      const ordered = await routeableCandidates(policy, policy.profile);
      const refs = new Set(ordered.map((model) => model.ref));
      const models = availableModels();
      const visible = new Set(allModels(models));
      const providerStates = new Map<string, ReturnType<typeof services.providers.get>>();
      const excluded = models
        .filter((model) => !refs.has(model.ref))
        .map((model) => {
          if (!providerStates.has(model.providerId))
            providerStates.set(model.providerId, services.providers.get(model.providerId));
          const saved = providerStates.get(model.providerId);
          const definition = providerDefinition(model.providerId);
          const reason = isOpenCodeAppModel(model)
            ? 'Available in the OpenCode app; standard Gateway routing unavailable.'
            : definition?.releaseState === 'Coming soon'
              ? 'Integration coming soon.'
              : definition?.releaseState === 'Beta' && saved?.enabled !== true
                ? 'Beta provider requires explicit enablement.'
                : saved?.enabled === false
                  ? 'Provider disabled or paused.'
                  : !visible.has(model.ref)
                    ? 'Connect valid credentials, restore quota, or remove model exclusion.'
                    : policy.allowedModels.length && !policy.allowedModels.includes(model.ref)
                      ? 'Outside this key’s model restriction.'
                      : 'Excluded by preset tier, capability, context, quota or spending policy.';
          return { modelRef: model.ref, reason };
        });
      return {
        profile: policy.profile,
        summary:
          policy.profile === 'fast'
            ? 'Prefer responsive, sufficiently capable free models.'
            : policy.profile === 'best'
              ? 'Prefer suitable quality within key, preset and global spending limits.'
              : policy.profile === 'long-context'
                ? 'Prefer safe conversation and output headroom.'
                : policy.profile === 'none'
                  ? 'Use the selected model, then the allowed fallback order.'
                  : 'Auto balances suitability, reliability, quota and response time. Free first; coding results guide edits and verification.',
        eligible: ordered.map((model, index) => ({
          modelRef: model.ref,
          providerId: model.providerId,
          order: index + 1,
          quotaHeadroom: services.quota
            .getWindows(model.providerId)
            .filter(
              (window) =>
                window.remaining !== null &&
                window.metric === 'requests' &&
                (window.modelRef === null || window.modelRef === model.ref),
            )
            .reduce<number | null>(
              (remaining, window) => Math.min(remaining ?? Infinity, window.remaining ?? Infinity),
              null,
            ),
        })),
        excluded,
        lastDecision:
          this.history({ ...(key ? { keyId: key.id } : {}), limit: 1 }).records[0] ?? null,
      };
    },
    async testConnection(
      id: string,
      protocol: 'chat' | 'responses' | 'anthropic' = 'chat',
      approvedCostUsd?: number,
    ) {
      const key = this.key(id);
      if (!key) throw new Error('Unknown or revoked Gateway key.');
      if (key.paidBackup && approvedCostUsd === undefined)
        throw new Error(
          'Use a free-only key or explicitly approve a cost ceiling for this paid-capable verification request.',
        );
      if (!handle) await this.start();
      const token = this.issueInternalToken(id, approvedCostUsd);
      const url = this.status.url;
      if (!url) {
        this.revokeInternalToken(token);
        throw new Error('Gateway stopped before verification. Start it and retry.');
      }
      try {
        const path =
          protocol === 'responses'
            ? '/v1/responses'
            : protocol === 'anthropic'
              ? '/v1/messages'
              : '/v1/chat/completions';
        const model =
          key.profile === 'none' ? (key.allowedModels[0] ?? 'ferry/auto') : 'ferry/auto';
        const response = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'x-ferry-internal-token': token, 'content-type': 'application/json' },
          body: JSON.stringify(
            protocol === 'responses'
              ? { model, input: 'Reply with Ready.', max_output_tokens: 32 }
              : {
                  model,
                  messages: [{ role: 'user', content: 'Reply with Ready.' }],
                  max_tokens: 32,
                },
          ),
          signal: AbortSignal.timeout(150_000),
        });
        await response.arrayBuffer();
        const traceId = response.headers.get('x-ferry-trace-id');
        const row = traceId
          ? (services.db.client
              .prepare(
                "SELECT data_json FROM gateway_requests WHERE json_extract(data_json,'$.traceId')=?",
              )
              .get(traceId) as { data_json: string } | undefined)
          : undefined;
        const record = row ? (JSON.parse(row.data_json) as GatewayRequestRecord) : undefined;
        return {
          ok: response.ok,
          requestId: record?.id ?? null,
          model: record?.modelRef ?? null,
          message: response.ok
            ? 'A real request through this key completed. Client installation still needs verification in the client.'
            : `Gateway request failed (${String(response.status)}). Check request details and provider readiness.`,
        };
      } finally {
        this.revokeInternalToken(token);
      }
    },
    async rotateKey(id: string, saveSecret: (secret: string) => Promise<void>) {
      const current = keys(services).find((key) => key.id === id && !key.revokedAt);
      if (!current) throw new Error('Unknown or revoked Gateway key.');
      const created = createGatewayKey(current, services.clock.now());
      await saveSecret(created.secret);
      const latest = keys(services).find((key) => key.id === id && !key.revokedAt);
      if (!latest) throw new Error('This key was revoked during rotation.');
      runtime.store.put({ ...latest, hash: created.key.hash });
      for (const [token, grant] of internalTokens)
        if (grant.keyId === id) internalTokens.delete(token);
      return {
        key: { id: current.id, name: current.name, profile: current.profile },
        secret: created.secret,
      };
    },
    requests() {
      return (
        services.db.client
          .prepare('SELECT data_json FROM gateway_requests ORDER BY at DESC LIMIT ?')
          .all(requestLogLimit) as { data_json: string }[]
      ).map((row) => JSON.parse(row.data_json) as GatewayRequestRecord);
    },
    get status() {
      return statusNow();
    },
    async start(settings = gatewaySettings(services)) {
      return await serialize(() => startNow(settings));
    },
    async stop() {
      return await serialize(stopNow);
    },
    createKey(name: string, profile: string) {
      const created = createGatewayKey({ name, profile });
      runtime.store.put(created.key);
      return { ...created, key: { ...created.key, hash: undefined } };
    },
    issueInternalToken(id: string, testCostCapUsd?: number) {
      const key = keys(services).find((entry) => entry.id === id && !entry.revokedAt);
      if (!key) throw new Error(`Gateway key not found: ${id}`);
      const token = randomBytes(32).toString('base64url');
      for (const [value, grant] of internalTokens)
        if (grant.expiresAt <= Date.now()) internalTokens.delete(value);
      internalTokens.set(token, {
        keyId: id,
        expiresAt: Date.now() + 10 * 60_000,
        ...(testCostCapUsd === undefined ? {} : { testCostCapUsd }),
      });
      return token;
    },
    key(id: string) {
      return this.listKeys().find((entry) => entry.id === id && !entry.revokedAt);
    },
    revokeInternalToken(token: string) {
      internalTokens.delete(token);
    },
    activeInternalTokenCount() {
      return internalTokens.size;
    },
    updateKey(
      id: string,
      patch: Partial<
        Pick<
          GatewayKey,
          | 'paidBackup'
          | 'client'
          | 'budgetUsd'
          | 'profile'
          | 'allowedModels'
          | 'rateLimit'
          | 'tokenLimitPerMinute'
          | 'tokenLimitPerDay'
          | 'concurrencyLimit'
          | 'compressToolResults'
          | 'terseSystemPrompt'
        >
      >,
    ) {
      const current = keys(services).find((entry) => entry.id === id);
      if (!current) throw new Error(`Gateway key not found: ${id}`);
      const updated = { ...current, ...patch };
      if (
        updated.paidBackup &&
        (!updated.budgetUsd || !Number.isFinite(updated.budgetUsd) || updated.budgetUsd <= 0)
      )
        throw new BudgetError('Paid backup requires an explicit positive dollar limit.');
      runtime.store.put(updated);
      return this.listKeys().find((entry) => entry.id === id);
    },
    listKeys() {
      return keys(services).map(({ hash: _hash, ...key }) => ({
        ...key,
        usage: runtime.store.usage(key.id),
        budgetUsedUsd: (
          services.db.client
            .prepare(
              'SELECT coalesce(sum(amount_usd),0) AS spent FROM (SELECT amount_usd FROM spend_charges WHERE key_id=? AND at >= ? UNION ALL SELECT amount_usd FROM spend_reservations WHERE key_id=? AND at >= ?)',
            )
            .get(
              key.id,
              `${services.clock.now().toISOString().slice(0, 7)}-01T00:00:00.000Z`,
              key.id,
              `${services.clock.now().toISOString().slice(0, 7)}-01T00:00:00.000Z`,
            ) as { spent: number }
        ).spent,
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
      return await serialize(async () => {
        const previous = gatewaySettings(services),
          wasRunning = !!handle;
        services.settings.put('gateway-settings', settings);
        try {
          if (handle) await stopNow();
          if (settings.enabled) await startNow(settings);
          return { ...settings, status: statusNow() };
        } catch (error) {
          services.settings.put('gateway-settings', previous);
          if (wasRunning) await startNow(previous);
          throw error;
        }
      });
    },
  };
  async function startNow(settings: GatewaySettings) {
    handle ??= await startGateway({
      runtime,
      internalTokens,
      port: settings.port,
      allowLan: settings.allowLan,
      allowLanConfirmed: settings.allowLan,
    });
    return statusNow();
  }
  async function stopNow() {
    await handle?.close();
    handle = undefined;
    return statusNow();
  }
  controllers.set(services, controller);
  return controller;
}
