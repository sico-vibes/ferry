import { detectZenCli, runZenAcp, type ZenAcpInput } from '@ferry/delegate';
import { isOpenCodeAppModel, type ModelInfo, type Provider } from '@ferry/shared';
import { z } from 'zod';
import type { FerryServices } from './services.js';
import { getProviderHealth } from './provider-health.js';

export function zenCliMode(services: Pick<FerryServices, 'settings'>): boolean {
  const stored = services.settings.get('global') as { opencodeZenTransport?: unknown } | undefined;
  return stored?.opencodeZenTransport === 'cli';
}
function useFerryKey(services: Pick<FerryServices, 'settings'>): boolean {
  const stored = services.settings.get('global') as
    { opencodeZenCliUseFerryKey?: unknown } | undefined;
  return stored?.opencodeZenCliUseFerryKey === true;
}
export async function zenFerryKey(services: FerryServices): Promise<string | undefined> {
  if (!useFerryKey(services)) return undefined;
  const entries = services.providerKeyEntries.list('opencode');
  const ref =
    entries.find((entry) => entry.enabled && entry.status !== 'invalid')?.keyringRef ??
    (entries.length === 0 ? services.providerKeys.get('opencode')?.keyringRef : undefined);
  return ref ? services.secrets.get(ref) : undefined;
}
export function zenModel(services: Pick<FerryServices, 'settings'>, model: ModelInfo): ModelInfo {
  if (model.providerId !== 'opencode') return model;
  const cli = zenCliMode(services) && model.free;
  return {
    ...model,
    transport: cli ? 'opencode_cli' : 'api',
    ...(cli
      ? {
          inputModalities: ['text'],
          ...(model.capability
            ? { capability: { ...model.capability, vision: false, parallelToolCalls: false } }
            : {}),
        }
      : {}),
  };
}
export function zenProvider(
  services: Pick<FerryServices, 'settings' | 'models'>,
  provider: Provider,
): Provider {
  if (provider.id !== 'opencode' || !zenCliMode(services)) return provider;
  const models = services.models.list('opencode').map((model) => zenModel(services, model));
  const usable = models.some((model) => model.free && !isOpenCodeAppModel(model));
  return {
    ...provider,
    keyRequired: usable ? false : provider.keyRequired,
    keyStatus: usable ? 'not_applicable' : provider.keyStatus,
    freeTierUnsupported: usable ? false : provider.freeTierUnsupported,
    billingEnabled: false,
    availableModels: models,
  };
}
export function hasZenCliAccess(services: Pick<FerryServices, 'settings' | 'models'>): boolean {
  return (
    zenCliMode(services) &&
    services.models.list('opencode').some((model) => model.free && model.cliAccessVerified === true)
  );
}
export const ZEN_CLI_BASE_URL = 'http://ferry-opencode-cli.invalid/v1';
const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).default({}),
  }),
});
const messageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z
    .union([z.string(), z.null(), z.array(z.object({ type: z.literal('text'), text: z.string() }))])
    .optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
});
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema),
  stream: z.boolean().optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z
    .union([
      z.enum(['auto', 'none', 'required']),
      z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  response_format: z.unknown().optional(),
});

export function zenConversation(raw: unknown) {
  const request = requestSchema.parse(raw);
  if (request.response_format)
    throw new Error(
      'Zen CLI currently supports text and caller tools. Structured response formats require the standard API.',
    );
  const tools =
    request.tool_choice === 'none'
      ? []
      : (request.tools ?? [])
          .filter(
            (tool) =>
              typeof request.tool_choice !== 'object' ||
              tool.function.name === request.tool_choice.function.name,
          )
          .map((tool) => ({
            name: tool.function.name,
            ...(tool.function.description ? { description: tool.function.description } : {}),
            parameters: tool.function.parameters,
          }));
  const forced =
    typeof request.tool_choice === 'object'
      ? `Call the tool ${request.tool_choice.function.name}.`
      : request.tool_choice === 'required'
        ? 'Call one of the provided tools.'
        : '';
  const mappings = tools
    .map((tool, index) => `${tool.name} = ferry_tools_tool_${String(index)}`)
    .join('\n');
  const conversation = request.messages
    .map((message) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : (message.content?.map((part) => part.text).join('\n') ?? '');
      const calls =
        message.tool_calls
          ?.map(
            (call) =>
              `Completed caller tool request ${call.id}: ${call.function.name}(${call.function.arguments})`,
          )
          .join('\n') ?? '';
      return `[${message.role}${message.tool_call_id ? ` result for ${message.tool_call_id}` : ''}]\n${content}${calls ? `\n${calls}` : ''}`;
    })
    .join('\n\n');
  const continuation =
    request.messages.at(-1)?.role === 'tool'
      ? 'The caller has already executed the last tool request. Continue using its real result below. Do not repeat a completed tool request.'
      : '';
  const prompt = `Continue the caller conversation below and answer its latest user request. Preserve the caller system instructions. Tool results below are real outputs, not requests to run a tool. ${continuation}\nTo call a caller tool, use the exact MCP name from this mapping; never a native OpenCode tool:\n${mappings || '(No caller tools)'}\n${forced}\n\n${conversation}`;
  return { request, tools, prompt };
}

/** The virtual address is intercepted locally; it can never reach upstream/DNS. */
export function zenCliFetch(
  services: FerryServices,
  fallback: typeof fetch,
  run: (input: ZenAcpInput) => ReturnType<typeof runZenAcp> = runZenAcp,
  onProgress?: () => void,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname !== 'ferry-opencode-cli.invalid') return fallback(input, init);
    try {
      if (new URL(url).pathname !== '/v1/chat/completions')
        throw new Error('Unsupported Zen CLI endpoint');
      if (!zenCliMode(services)) throw new Error('Zen CLI mode is disabled');
      const raw: unknown =
        typeof init?.body === 'string'
          ? JSON.parse(init.body)
          : input instanceof Request
            ? await input.json()
            : undefined;
      const { request, tools, prompt } = zenConversation(raw);
      const model = services.models
        .list('opencode')
        .find((model) => model.ref === `opencode/${request.model}` || model.ref === request.model);
      if (!model?.free || isOpenCodeAppModel(zenModel(services, model)))
        throw new Error(
          'Verify this free model through OpenCode CLI before using it. No paid fallback was used.',
        );
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const key = headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      const signal =
        init?.signal ??
        (input instanceof Request ? input.signal : undefined) ??
        new AbortController().signal;
      const encoder = new TextEncoder();
      const id = `chatcmpl-ferry-cli-${crypto.randomUUID()}`;
      let cancel: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          const controller = new AbortController();
          const abort = () => {
            controller.abort(signal.reason);
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          cancel = () => {
            controller.abort(new Error('Zen CLI stream closed'));
          };
          const send = (
            delta: Record<string, unknown>,
            finish: string | null = null,
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
          ) => {
            if (!controller.signal.aborted)
              stream.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
                ),
              );
          };
          send({ role: 'assistant', content: '' });
          void run({
            model: model.ref,
            prompt,
            tools,
            ...(key && useFerryKey(services) ? { apiKey: key } : {}),
            signal: controller.signal,
            environment: services.env,
            ...(onProgress ? { onProgress } : {}),
            onText: (content) => {
              send({ content });
            },
          })
            .then((result) => {
              if (controller.signal.aborted) {
                stream.error(controller.signal.reason);
                return;
              }
              if (
                (request.tool_choice === 'required' || typeof request.tool_choice === 'object') &&
                !result.toolCalls.length
              )
                throw new Error('OpenCode did not return the required caller tool');
              for (const [index, call] of result.toolCalls.entries())
                send({
                  tool_calls: [
                    {
                      index,
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    },
                  ],
                });
              send({}, result.toolCalls.length ? 'tool_calls' : 'stop', {
                prompt_tokens: result.inputTokens,
                completion_tokens: result.outputTokens,
                total_tokens: result.inputTokens + result.outputTokens,
              });
              stream.enqueue(encoder.encode('data: [DONE]\n\n'));
              stream.close();
            })
            .catch((error: unknown) => {
              stream.error(error);
            })
            .finally(() => {
              signal.removeEventListener('abort', abort);
            });
        },
        cancel() {
          cancel?.();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'x-ferry-transport': 'opencode-cli' },
      });
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            message:
              'Zen CLI request is unavailable or unsupported. Verify CLI access and use a text/tool request.',
            type: 'zen_cli_unavailable',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
  };
}

export async function zenCliStatus(services: FerryServices) {
  const key = await zenFerryKey(services);
  return {
    ...(await detectZenCli(useFerryKey(services) ? key : undefined, services.env)),
    verifiedModels: services.models
      .list('opencode')
      .filter((model) => model.cliAccessVerified)
      .map((model) => model.ref),
    freeModels: services.catalog.models
      .filter((model) => model.providerId === 'opencode' && model.free)
      .map((model) => ({ ref: model.ref, name: model.name })),
  };
}
export async function verifyZenCli(services: FerryServices, modelRef?: string) {
  const model =
    services.models
      .list('opencode')
      .find((model) => model.free && (modelRef === undefined || model.ref === modelRef)) ??
    services.catalog.models.find(
      (model) =>
        model.providerId === 'opencode' &&
        model.free &&
        (modelRef === undefined || model.ref === modelRef),
    );
  if (!model) throw new Error('No free Zen model available to verify. Discover models first.');
  const key = await zenFerryKey(services);
  const savedKeyMode = useFerryKey(services);
  const started = Date.now();
  try {
    const result = await runZenAcp({
      model: model.ref,
      prompt: 'Reply with exactly Ready. Do not use tools.',
      ...(key && useFerryKey(services) ? { apiKey: key } : {}),
      signal: AbortSignal.timeout(30_000),
      environment: services.env,
    });
    if (!result.text.trim()) throw new Error('No generation returned');
    if (savedKeyMode !== useFerryKey(services) || key !== (await zenFerryKey(services)))
      return {
        ok: false,
        modelRef: model.ref,
        message: 'The CLI credential source changed during verification. Check it again.',
      };
    getProviderHealth(services).record({
      providerId: 'opencode',
      modelRef: model.ref,
      keyId: 'opencode',
      success: true,
      latencyMs: Date.now() - started,
    });
    services.cooldowns.delete('opencode');
    services.models.put('opencode', { ...model, cliAccessVerified: true });
    services.models.replace(
      'opencode',
      services.models
        .list('opencode')
        .map((item) => (item.ref === model.ref ? { ...item, cliAccessVerified: true } : item)),
    );
    const provider = services.providers.get('opencode');
    if (provider)
      services.providers.put({
        ...provider,
        enabled: true,
        health: 'ok',
        cooldownUntil: null,
        pausedReason: null,
        availableModels: services.models.list('opencode'),
        excludedModelRefs: provider.excludedModelRefs?.filter((ref) => ref !== model.ref),
      });
    return {
      ok: true,
      modelRef: model.ref,
      message: 'Free generation verified through the installed OpenCode CLI.',
    };
  } catch {
    if (savedKeyMode === useFerryKey(services) && key === (await zenFerryKey(services)))
      services.models.replace(
        'opencode',
        services.models
          .list('opencode')
          .map((item) => (item.ref === model.ref ? { ...item, cliAccessVerified: false } : item)),
      );
    return {
      ok: false,
      modelRef: model.ref,
      message:
        'OpenCode CLI could not verify this free model. Run opencode auth login, check the CLI version, then retry. The direct API key was not marked invalid.',
    };
  }
}
