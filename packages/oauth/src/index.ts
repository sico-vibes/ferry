import {
  type AuthEvent,
  type AuthPrompt,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type CredentialStore,
  type Context,
  type Message as PiMessage,
  type AssistantMessage as PiAssistantMessage,
  type JsonObject,
  createModels,
} from '@earendil-works/pi-ai';
import {
  forgetSecret,
  isKnownSecret,
  ModelInfoSchema,
  ProviderIdSchema,
  ModelRefSchema,
  rememberSecret,
} from '@ferry/shared';
import type { Message, ModelInfo } from '@ferry/shared';
import { z } from 'zod';
import type { SecretStore } from '@ferry/secrets';

export type OAuthProviderId = string;
export function isSupportedOAuthProvider(id: string): id is OAuthProviderId {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}
export type OAuthLoginEvent =
  | { type: 'open_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: 'progress'; message: string }
  | { type: 'success' }
  | { type: 'error'; message: string };

export interface OAuthProviderInfo {
  id: OAuthProviderId;
  tag: 'subscription_oauth' | 'legit';
  name: string;
  subscriptionRequired: boolean;
  models: string[];
  riskLevel: 'low' | 'medium' | 'high';
  riskText: string;
  group: 'official' | 'subscription' | 'gateway';
  advanced?: boolean;
  actionAvailable: true;
}

export interface LoginOptions {
  openUrl(url: string): Promise<void> | void;
  onDeviceCode(info: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  }): void;
  onProgress?(event: OAuthLoginEvent): void;
  signal?: AbortSignal;
  gateway?: string;
}

const RISK_TEXT =
  'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.';
const names: Record<string, string> = {
  anthropic: 'Anthropic Claude Pro/Max',
  'openai-codex': 'OpenAI ChatGPT',
  'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter',
  'kimi-coding': 'Kimi Code',
  meta: 'Meta Muse',
  xai: 'xAI Grok',
  radius: 'Radius',
};
type OAuthFlowLoader = (options?: { name?: string; gateway?: string }) => Promise<OAuthAuth>;
let flowLoadersPromise: Promise<Map<string, OAuthFlowLoader>> | undefined;

function providerIdFromLoaderName(name: string): string | undefined {
  if (!/^load[A-Za-z0-9]+OAuth$/.test(name)) return undefined;
  const flow = name.slice(4, -5);
  const aliases: Record<string, string> = {
    Anthropic: 'anthropic',
    OpenAICodex: 'openai-codex',
    GitHubCopilot: 'github-copilot',
    OpenRouter: 'openrouter',
    KimiCoding: 'kimi-coding',
    Meta: 'meta',
    Xai: 'xai',
    Radius: 'radius',
  };
  return aliases[flow] ?? flow.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function discoverOAuthFlowExports(
  exports: Record<string, unknown>,
): Map<string, OAuthFlowLoader> {
  const flows = new Map<string, OAuthFlowLoader>();
  for (const [name, loader] of Object.entries(exports)) {
    const id = providerIdFromLoaderName(name);
    if (id && typeof loader === 'function') flows.set(id, loader as OAuthFlowLoader);
  }
  return flows;
}

async function piOAuthFlowLoaders(): Promise<Map<string, OAuthFlowLoader>> {
  flowLoadersPromise ??= (async () => {
    const moduleUrl = new URL(
      '../auth/oauth/load.js',
      import.meta.resolve('@earendil-works/pi-ai/providers/all'),
    );
    const module = (await import(moduleUrl.href)) as Record<string, unknown>;
    return discoverOAuthFlowExports(module);
  })();
  return flowLoadersPromise;
}

async function loadProvider(
  id: string,
  options?: { gateway?: string },
): Promise<{ auth: OAuthAuth; provider: Provider }> {
  const loader = (await piOAuthFlowLoaders()).get(id);
  if (!loader) throw new Error(`Unsupported subscription OAuth provider: ${id}`);
  const gateway = id === 'radius' ? validateRadiusGatewayUrl(options?.gateway ?? '') : undefined;
  const auth = await loader(
    id === 'radius' ? { name: 'Radius', gateway: gateway ?? '' } : undefined,
  );
  const module = (await import(`@earendil-works/pi-ai/providers/${id}`)) as Record<string, unknown>;
  const constructor = Object.values(module).find(
    (value): value is (options?: { gateway?: string }) => Provider =>
      typeof value === 'function' && value.name.endsWith('Provider'),
  );
  if (!constructor) throw new Error(`pi-ai provider export is missing for ${id}`);
  const provider = constructor(id === 'radius' ? { gateway: gateway ?? '' } : undefined);
  return { auth, provider };
}
const secretKey = (id: OAuthProviderId) => (id === 'openrouter' ? 'openrouter' : `oauth:${id}`);

export function validateRadiusGatewayUrl(gateway: string): string {
  const url = new URL(gateway);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Radius gateway URL must be an HTTP(S) URL without embedded credentials');
  return url.toString();
}

function providerId(id: string): OAuthProviderId {
  if (isSupportedOAuthProvider(id)) return id;
  throw new Error(`Unsupported subscription OAuth provider: ${String(id)}`);
}

function credentialStore(secrets: SecretStore): CredentialStore {
  const locks = new Map<string, Promise<void>>();
  const registerCredential = (credential: OAuthCredential) => {
    if (!isKnownSecret(credential.access)) rememberSecret(credential.access);
    if (!isKnownSecret(credential.refresh)) rememberSecret(credential.refresh);
  };
  const read = async (id: string) => {
    const value = await secrets.get(secretKey(providerId(id)));
    if (!value) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('type' in parsed) ||
      parsed.type !== 'oauth'
    )
      throw new Error('Stored OAuth credential is invalid');
    const credential = parsed as OAuthCredential;
    registerCredential(credential);
    return credential;
  };
  return {
    read,
    async list() {
      const entries = await Promise.all(
        [...(await piOAuthFlowLoaders()).keys()]
          .filter((id) => id !== 'openrouter' && id !== 'radius')
          .map(async (id) =>
            (await secrets.has(secretKey(id)))
              ? { providerId: id, type: 'oauth' as const }
              : undefined,
          ),
      );
      return entries.filter((item): item is NonNullable<typeof item> => item !== undefined);
    },
    async modify(id, fn) {
      const key = providerId(id);
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(
        key,
        previous.then(() => next),
      );
      await previous;
      try {
        const old = await read(key);
        const value = await fn(old);
        if (value) await secrets.set(secretKey(key), JSON.stringify(value));
        else await secrets.delete(secretKey(key));
        const nextOAuth = value?.type === 'oauth' ? value : undefined;
        const oldOAuth = old?.type === 'oauth' ? old : undefined;
        if (nextOAuth) registerCredential(nextOAuth);
        if (oldOAuth?.access && oldOAuth.access !== nextOAuth?.access)
          forgetSecret(oldOAuth.access);
        if (oldOAuth?.refresh && oldOAuth.refresh !== nextOAuth?.refresh)
          forgetSecret(oldOAuth.refresh);
        return value;
      } finally {
        release();
      }
    },
    async delete(id) {
      const key = providerId(id);
      const old = await read(key);
      await secrets.delete(secretKey(key));
      if (old) {
        forgetSecret(old.access);
        forgetSecret(old.refresh);
      }
    },
  };
}

export async function listOAuthProviders(): Promise<OAuthProviderInfo[]> {
  const preferredOrder = [
    'anthropic',
    'openai-codex',
    'github-copilot',
    'openrouter',
    'kimi-coding',
    'meta',
    'xai',
    'radius',
  ];
  const preferredRanks = new Map(preferredOrder.map((id, index) => [id, index]));
  const providerIds = [...(await piOAuthFlowLoaders()).keys()].sort(
    (left, right) =>
      (preferredRanks.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (preferredRanks.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right),
  );
  return await Promise.all(
    providerIds.map(async (id) => {
      const { provider } = id === 'radius' ? { provider: undefined } : await loadProvider(id);
      const official = id === 'openrouter';
      const gateway = id === 'radius';
      return {
        id,
        tag: official ? 'legit' : 'subscription_oauth',
        name: names[id] ?? id.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase()),
        subscriptionRequired: !official && !gateway,
        models: provider?.getModels().map((model) => model.name) ?? [],
        riskLevel: official ? 'low' : gateway ? 'medium' : 'high',
        riskText: official
          ? 'Official OpenRouter PKCE login. The user-owned API key is stored in the OS keyring.'
          : gateway
            ? 'Gateway OAuth uses the URL you provide. Review that gateway’s terms and trust boundary.'
            : RISK_TEXT,
        group: official ? 'official' : gateway ? 'gateway' : 'subscription',
        ...(gateway ? { advanced: true } : {}),
        actionAvailable: true,
      };
    }),
  );
}

/** Curated IDs from pi-ai 0.87.1 kept routable through pi-ai's native OAuth stream. */
export const oauthModelCatalog = [
  {
    providerId: 'anthropic',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    reasoning: true,
  },
  {
    providerId: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    reasoning: true,
  },
  {
    providerId: 'openai-codex',
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    contextWindow: 272_000,
    maxOutput: 128_000,
    reasoning: true,
  },
  {
    providerId: 'openai-codex',
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    contextWindow: 272_000,
    maxOutput: 128_000,
    reasoning: true,
  },
  {
    providerId: 'github-copilot',
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol · Copilot',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    reasoning: true,
  },
  {
    providerId: 'github-copilot',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5 · Copilot',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    reasoning: true,
  },
  ...[
    {
      providerId: 'kimi-coding',
      id: 'k3',
      name: 'Kimi K3',
      contextWindow: 1_048_576,
      maxOutput: 131_072,
    },
    {
      providerId: 'kimi-coding',
      id: 'k3-256k',
      name: 'Kimi K3-256K',
      contextWindow: 262_144,
      maxOutput: 131_072,
    },
    {
      providerId: 'kimi-coding',
      id: 'kimi-for-coding',
      name: 'Kimi For Coding',
      contextWindow: 1_048_576,
      maxOutput: 32_768,
    },
    {
      providerId: 'meta',
      id: 'muse-spark-1.2',
      name: 'Muse Spark 1.2',
      contextWindow: 1_048_576,
      maxOutput: 131_072,
    },
    {
      providerId: 'meta',
      id: 'muse-spark-1.3',
      name: 'Muse Spark 1.3',
      contextWindow: 1_048_576,
      maxOutput: 131_072,
    },
    {
      providerId: 'xai',
      id: 'grok-4.5',
      name: 'Grok 4.5',
      contextWindow: 500_000,
      maxOutput: 500_000,
    },
    {
      providerId: 'xai',
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500_000,
      maxOutput: 500_000,
    },
    {
      providerId: 'xai',
      id: 'grok-4.7',
      name: 'Grok 4.7',
      contextWindow: 500_000,
      maxOutput: 500_000,
    },
  ].map((model) => ({ ...model, reasoning: true })),
].map((model) =>
  ModelInfoSchema.parse({
    ref: ModelRefSchema.parse(`${model.providerId}/${model.id}`),
    providerId: ProviderIdSchema.parse(model.providerId),
    name: model.name,
    tier: model.reasoning ? 'T1' : 'T2',
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    toolCalling: true,
    reasoning: model.reasoning,
    free: false,
    priceInPerM: null,
    priceOutPerM: null,
  }),
);

export async function startLoginWithAuth(
  id: string,
  auth: OAuthAuth,
  options: LoginOptions,
  secrets: SecretStore,
): Promise<void> {
  const key = providerId(id);
  const signal = options.signal ?? new AbortController().signal;
  const interaction = {
    signal,
    prompt: (prompt: AuthPrompt) => {
      if (signal.aborted) return Promise.reject(new Error('OAuth login cancelled'));
      if (prompt.type === 'select') {
        const defaultOption = prompt.options[0];
        return defaultOption
          ? Promise.resolve(defaultOption.id)
          : Promise.reject(new Error('OAuth provider did not offer a login method'));
      }
      if (prompt.type === 'text') return Promise.resolve('');
      return Promise.reject(new Error('This OAuth provider requested an unsupported login prompt'));
    },
    notify: (event: AuthEvent) => {
      if (event.type === 'auth_url') {
        options.onProgress?.({
          type: 'open_url',
          url: event.url,
          ...(event.instructions ? { instructions: event.instructions } : {}),
        });
        void Promise.resolve(options.openUrl(event.url)).catch((error: unknown) =>
          options.onProgress?.({
            type: 'error',
            message: error instanceof Error ? error.message : 'Could not open sign-in page',
          }),
        );
      } else if (event.type === 'device_code') {
        const info = {
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...(event.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: event.expiresInSeconds }),
        };
        options.onDeviceCode(info);
        options.onProgress?.({ type: 'device_code', ...info });
      } else options.onProgress?.({ type: 'progress', message: event.message });
    },
  };
  try {
    const credential = await auth.login(interaction);
    await secrets.set(
      secretKey(key),
      key === 'openrouter' ? credential.access : JSON.stringify({ ...credential, type: 'oauth' }),
    );
    rememberSecret(credential.access);
    rememberSecret(credential.refresh);
    options.onProgress?.({ type: 'success' });
  } catch (error) {
    options.onProgress?.({
      type: 'error',
      message: error instanceof Error ? error.message : 'OAuth login failed',
    });
    throw error;
  }
}

export async function startLogin(
  id: string,
  options: LoginOptions,
  secrets: SecretStore,
): Promise<void> {
  const key = providerId(id);
  const { auth } = await loadProvider(key, {
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
  });
  return startLoginWithAuth(id, auth, options, secrets);
}

export async function refreshWithAuth(
  id: string,
  auth: OAuthAuth,
  secrets: SecretStore,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const key = providerId(id);
  const store = credentialStore(secrets);
  const credentials = await store.read(key);
  if (!credentials) throw new Error(`No saved OAuth login for ${key}`);
  if (credentials.type !== 'oauth') throw new Error(`Saved credential for ${key} is not OAuth`);
  const next = await auth.refresh(credentials, signal ?? new AbortController().signal);
  await secrets.set(secretKey(key), JSON.stringify({ ...next, type: 'oauth' }));
  if (next.access !== credentials.access) {
    rememberSecret(next.access);
    forgetSecret(credentials.access);
  }
  if (next.refresh !== credentials.refresh) {
    rememberSecret(next.refresh);
    forgetSecret(credentials.refresh);
  }
  return next;
}

export async function refresh(
  id: string,
  secrets: SecretStore,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const { auth } = await loadProvider(providerId(id));
  return await refreshWithAuth(id, auth, secrets, signal);
}

export async function logout(id: string, secrets: SecretStore): Promise<void> {
  const key = providerId(id);
  const value = await secrets.get(secretKey(key));
  if (value) {
    await secrets.delete(secretKey(key));
    if (key !== 'openrouter') {
      const credential = JSON.parse(value) as OAuthCredential;
      forgetSecret(credential.access);
      forgetSecret(credential.refresh);
    }
    return;
  }
  await secrets.delete(secretKey(key));
}

/** The pi-ai streaming gateway retains native OAuth auth and tool-call events. */
export async function createOAuthModelGateway(secrets: SecretStore) {
  const models = createModels({ credentials: credentialStore(secrets) });
  for (const id of (await piOAuthFlowLoaders()).keys()) {
    if (id === 'openrouter' || id === 'radius') continue;
    const { provider } = await loadProvider(id);
    models.setProvider(provider);
  }
  return models;
}

export interface OAuthStepRequest {
  model: ModelInfo;
  system: string;
  messages: readonly Message[];
  tools: readonly { name: string; title: string; schema: z.ZodType }[];
  signal: AbortSignal;
  onDelta(text: string): void;
}

/** Adapts Ferry agent steps to pi-ai's native OAuth-aware streaming and tool-call API. */
export async function streamOAuthStep(secrets: SecretStore, request: OAuthStepRequest) {
  const gateway = await createOAuthModelGateway(secrets);
  const [providerId, modelId] = request.model.ref.split('/', 2);
  if (!providerId || !modelId)
    throw new Error(`Invalid OAuth model reference: ${request.model.ref}`);
  const model = gateway.getModel(providerId, modelId);
  if (!model) throw new Error(`pi-ai model not found: ${request.model.ref}`);
  const messages: PiMessage[] = [];
  const timestamp = Date.now();
  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => ({ type: 'text' as const, text: part.text })),
        timestamp,
      });
      continue;
    }
    const content: PiAssistantMessage['content'] = [];
    for (const part of message.parts) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'reasoning') content.push({ type: 'thinking', thinking: part.text });
      else if (part.type === 'tool_call' && part.status !== 'denied')
        content.push({
          type: 'toolCall',
          id: part.id,
          name: part.tool,
          arguments: JSON.parse(JSON.stringify(part.args)) as JsonObject,
        });
    }
    if (content.length)
      messages.push({
        role: 'assistant',
        content,
        api: model.api,
        provider: providerId,
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp,
      });
    for (const part of message.parts)
      if (part.type === 'tool_call' && part.output)
        messages.push({
          role: 'toolResult',
          toolCallId: part.id,
          toolName: part.tool,
          content: [{ type: 'text', text: part.output.text }],
          isError: part.status === 'failed',
          timestamp,
        });
  }
  const context: Context = {
    systemPrompt: request.system,
    messages,
    tools: request.tools.map((item) => ({
      name: item.name,
      description: item.title,
      parameters: z.toJSONSchema(item.schema),
    })),
  };
  const stream = gateway.stream(model, context, { signal: request.signal });
  let text = '';
  let reasoning = '';
  for await (const event of stream) {
    if (event.type === 'error')
      throw new Error(event.error.errorMessage ?? 'pi-ai OAuth stream failed');
    if (event.type === 'text_delta') {
      text += event.delta;
      request.onDelta(event.delta);
    } else if (event.type === 'thinking_delta') reasoning += event.delta;
  }
  const result = await stream.result();
  if (result.errorMessage) throw new Error(result.errorMessage);
  const toolCalls = result.content.flatMap((part) =>
    part.type === 'toolCall' ? [{ id: part.id, name: part.name, input: part.arguments }] : [],
  );
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    finishReason: result.stopReason,
  };
}
