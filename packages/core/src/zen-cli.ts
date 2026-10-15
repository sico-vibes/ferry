import {
  isCliModelVerified,
  ModelRefSchema,
  type CliConnection,
  type ModelInfo,
  type Provider,
} from '@ferry/shared';
import { z } from 'zod';
import type { FerryServices } from './services.js';
import { getCliBroker, zenCliSurfaceSelected } from './cli-broker.js';

/**
 * Installed-CLI compatibility hooks for the legacy Zen opt-in.
 *
 * The canonical `opencode-cli/opencode/<id>` route served by the shared `CliBroker` is the single
 * installed-CLI route. The legacy `opencodeZenTransport: 'cli'` flag and the old persisted
 * `opencode/<id>` model refs are kept working as *aliases*: they resolve to the discovered canonical
 * route in the broker and never create a second CLI row, a second credential source or a paid
 * fallback.
 */

/**
 * Whether the installed OpenCode CLI transport is selected for one surface.
 *
 * Before the one-time shared migration the legacy flag applied to both surfaces. Afterwards the
 * shared per-surface record is authoritative, so an explicit `native: false` can never be bypassed by
 * the old flag for the native surface (nor `gateway: false` for the gateway surface). Defaults to
 * `native`, the surface the legacy flag originally enabled.
 */
export function zenCliMode(
  services: Pick<FerryServices, 'settings'>,
  surface: 'native' | 'gateway' = 'native',
): boolean {
  return zenCliSurfaceSelected(services, surface);
}

function useFerryKey(services: Pick<FerryServices, 'settings'>): boolean {
  const stored = services.settings.get('global') as
    { opencodeZenCliUseFerryKey?: unknown } | undefined;
  return stored?.opencodeZenCliUseFerryKey === true;
}

/**
 * The saved Ferry Zen key, memory-only, when the legacy Ferry-key opt-in is on. Used by the legacy
 * gateway/native API fallback paths that still accept it; the shared broker resolves its own
 * credential evidence and never reads this itself.
 */
export async function zenFerryKey(services: FerryServices): Promise<string | undefined> {
  if (!useFerryKey(services)) return undefined;
  const entries = services.providerKeyEntries.list('opencode');
  const ref =
    entries.find((entry) => entry.enabled && entry.status !== 'invalid')?.keyringRef ??
    (entries.length === 0 ? services.providerKeys.get('opencode')?.keyringRef : undefined);
  return ref ? services.secrets.get(ref) : undefined;
}

/**
 * Compatibility hook: an OpenCode API model is never rewritten into an installed-CLI route. The
 * single CLI route is the discovered canonical `opencode-cli/opencode/<id>` row; keeping the API ref
 * an API ref is what prevents the same Zen model from being listed twice as a CLI route.
 */
export function zenModel(_services: Pick<FerryServices, 'settings'>, model: ModelInfo): ModelInfo {
  return model;
}

/** Compatibility hook kept for callers; the API provider row stays a truthful API provider. */
export function zenProvider(
  _services: Pick<FerryServices, 'settings' | 'models'>,
  provider: Provider,
): Provider {
  return provider;
}

/**
 * True when the shared OpenCode CLI connection carries a real per-model verification receipt for a
 * genuinely free Zen model. Discovery alone never counts; this is the plugin point that lets a
 * free-tier-restricted API provider still surface its verified CLI route.
 */
export function hasZenCliAccess(services: FerryServices): boolean {
  const connection = openCodeConnection(services);
  if (!connection) return false;
  return connection.models.some(
    (model) =>
      model.billing === 'free' &&
      model.upstreamProvider === 'opencode' &&
      isCliModelVerified(connection, model.ref),
  );
}

function openCodeConnection(services: FerryServices): CliConnection | undefined {
  return getCliBroker(services, () => undefined)
    .connections()
    .find((connection) => connection.kind === 'opencode-cli');
}

/** The virtual address is intercepted locally by the legacy API fallback; never reachable upstream. */
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

export interface ZenCliStatus {
  available: boolean;
  version: string | null;
  executable: string | null;
  credentialSource: 'opencode' | 'opencode_go' | 'ferry' | 'anonymous';
  verifiedModels: string[];
  freeModels: { ref: string; name: string }[];
}

function openCodeCredentialSource(
  services: FerryServices,
  connection: CliConnection | undefined,
): ZenCliStatus['credentialSource'] {
  const stored = services.settings.get('global') as
    | {
        cliConnections?: Record<string, { credentialMode?: unknown; credentialProvider?: unknown }>;
      }
    | undefined;
  const record = stored?.cliConnections?.['opencode-cli'];
  const mode =
    record?.credentialMode === 'anonymous' || record?.credentialMode === 'ferry'
      ? record.credentialMode
      : 'installed';
  const offer =
    typeof record?.credentialProvider === 'string' && record.credentialProvider.trim()
      ? record.credentialProvider.trim()
      : null;
  if (mode === 'anonymous') return 'anonymous';
  // Ferry mode reports its own source; whether the key is actually readable is decided by the
  // verification itself, never by a second credential probe here.
  if (mode === 'ferry') return 'ferry';
  // An explicit installed-Go offer is the only supported cross-provider credential.
  if (offer === 'opencode-go') return 'opencode_go';
  // Installed mode: reuse the shared discovery evidence, never a second auth-store read.
  if (connection?.account.label === 'OpenCode Go') return 'opencode_go';
  if (connection?.account.state === 'signed_in' && connection.account.key !== null)
    return 'opencode';
  return 'anonymous';
}

/**
 * Thin facade over the shared cached OpenCode connection. It never runs detection or a generation
 * itself: `available`/`version`/`executable` and the verified models come from the cached broker
 * snapshot, and `freeModels` contains only its discovered free Zen models in canonical CLI refs. Go credential
 * detection and Zen generation proof stay separate: a Go credential never appears in
 * `verifiedModels` without a real Zen generation.
 */
export function zenCliStatus(services: FerryServices): Promise<ZenCliStatus> {
  const connection = openCodeConnection(services);
  const verifiedModels = connection
    ? connection.models
        .filter((model) => model.billing === 'free' && isCliModelVerified(connection, model.ref))
        .map((model) => model.ref)
    : [];
  const freeModels = (connection?.models ?? [])
    .filter(
      (model) => model.billing === 'free' && model.upstreamProvider === 'opencode' && !model.hidden,
    )
    .map((model) => ({ ref: model.ref, name: model.name }));
  return Promise.resolve({
    available: connection?.install.installed ?? false,
    version: connection?.install.version ?? null,
    executable: connection?.install.executable ?? null,
    credentialSource: openCodeCredentialSource(services, connection),
    verifiedModels,
    freeModels,
  });
}

/**
 * Thin facade over the shared broker verification. The requested ref may be a canonical
 * `opencode-cli/opencode/<id>` or a legacy `opencode/<id>` alias; either resolves to the discovered
 * canonical model. The real generation, credential resolution, per-model receipt and redacted error
 * all come from the broker, so the API path and the CLI path share exactly one verification.
 */
export async function verifyZenCli(
  services: FerryServices,
  modelRef?: string,
): Promise<{ ok: boolean; modelRef: string | null; message: string }> {
  const broker = getCliBroker(services, () => undefined);
  const connection = openCodeConnection(services);
  const freeZen = (connection?.models ?? []).filter(
    (model) => model.billing === 'free' && model.upstreamProvider === 'opencode' && !model.hidden,
  );
  const requestedModel =
    modelRef === undefined ? undefined : broker.model(ModelRefSchema.parse(modelRef))?.model;
  if (
    modelRef !== undefined &&
    (requestedModel?.billing !== 'free' ||
      requestedModel.upstreamProvider !== 'opencode' ||
      requestedModel.hidden)
  )
    return {
      ok: false,
      modelRef,
      message:
        'The requested model is not a discovered free Zen model. Refresh detection and choose an available free model.',
    };
  const target =
    requestedModel?.billing === 'free' && requestedModel.upstreamProvider === 'opencode'
      ? requestedModel
      : freeZen[0];
  if (!target)
    return {
      ok: false,
      modelRef: modelRef ?? null,
      message:
        'No free Zen model is discovered for the installed OpenCode CLI yet. Refresh detection and retry.',
    };
  const result = await broker.verify('opencode-cli', target.ref);
  // Preserve the caller's requested ref (a legacy pin, profile or key entry) while the underlying
  // proof and producer stay canonical.
  return {
    ok: result.ok,
    modelRef: modelRef ?? result.modelRef ?? target.ref,
    message: result.message,
  };
}
