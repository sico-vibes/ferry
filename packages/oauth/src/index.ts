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

export type OAuthProviderId = 'anthropic' | 'openai-codex' | 'github-copilot';
export type OAuthLoginEvent =
  | { type: 'open_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: 'progress'; message: string }
  | { type: 'success' }
  | { type: 'error'; message: string };

export interface OAuthProviderInfo {
  id: OAuthProviderId;
  tag: 'subscription_oauth';
  name: string;
  subscriptionRequired: true;
  models: string[];
  riskLevel: 'high';
  riskText: string;
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
}

const RISK_TEXT =
  'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.';
const loaders: Record<OAuthProviderId, () => Promise<{ auth: OAuthAuth; provider: Provider }>> = {
  anthropic: async () => {
    const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
    const provider = anthropicProvider();
    if (!provider.auth.oauth) throw new Error('Anthropic OAuth is unavailable in pi-ai');
    return { auth: provider.auth.oauth, provider };
  },
  'openai-codex': async () => {
    const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex');
    const provider = openaiCodexProvider();
    if (!provider.auth.oauth) throw new Error('OpenAI Codex OAuth is unavailable in pi-ai');
    return { auth: provider.auth.oauth, provider };
  },
  'github-copilot': async () => {
    const { githubCopilotProvider } =
      await import('@earendil-works/pi-ai/providers/github-copilot');
    const provider = githubCopilotProvider();
    if (!provider.auth.oauth) throw new Error('GitHub Copilot OAuth is unavailable in pi-ai');
    return { auth: provider.auth.oauth, provider };
  },
};
const names: Record<OAuthProviderId, string> = {
  anthropic: 'Anthropic Claude Pro/Max',
  'openai-codex': 'OpenAI ChatGPT',
  'github-copilot': 'GitHub Copilot',
};
const secretKey = (id: OAuthProviderId) => `oauth:${id}`;

function providerId(id: string): OAuthProviderId {
  if (Object.hasOwn(loaders, id)) return id as OAuthProviderId;
  throw new Error(`Unsupported subscription OAuth provider: ${id}`);
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
        (Object.keys(loaders) as OAuthProviderId[]).map(async (id) =>
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
  return await Promise.all(
    (Object.keys(loaders) as OAuthProviderId[]).map(async (id) => {
      const { provider } = await loaders[id]();
      return {
        id,
        tag: 'subscription_oauth',
        name: names[id],
        subscriptionRequired: true,
        models: provider.getModels().map((model) => model.name),
        riskLevel: 'high',
        riskText: RISK_TEXT,
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
    await secrets.set(secretKey(key), JSON.stringify({ ...credential, type: 'oauth' }));
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
  const { auth } = await loaders[providerId(id)]();
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
  const { auth } = await loaders[providerId(id)]();
  return await refreshWithAuth(id, auth, secrets, signal);
}

export async function logout(id: string, secrets: SecretStore): Promise<void> {
  const value = await secrets.get(secretKey(providerId(id)));
  if (value) {
    const credential = JSON.parse(value) as OAuthCredential;
    await secrets.delete(secretKey(providerId(id)));
    forgetSecret(credential.access);
    forgetSecret(credential.refresh);
    return;
  }
  await secrets.delete(secretKey(providerId(id)));
}

/** The pi-ai streaming gateway retains native OAuth auth and tool-call events. */
export async function createOAuthModelGateway(secrets: SecretStore) {
  const models = createModels({ credentials: credentialStore(secrets) });
  for (const id of Object.keys(loaders) as OAuthProviderId[]) {
    const { provider } = await loaders[id]();
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
