import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mapProviderError } from '@ferry/providers';
import { classifyProviderError } from '@ferry/router';
import {
  canonicalToGatewayMessages,
  anthropicToCanonical,
  finalizeCanonicalStream,
  geminiToCanonical,
  openAiChatToCanonical,
  openAiResponsesToCanonical,
} from './canonical.js';

export type GatewayProfile = string;
export interface GatewayKey {
  id: string;
  name: string;
  profile: GatewayProfile;
  allowedModels: string[];
  rateLimit: number | null;
  tokenLimitPerMinute: number | null;
  tokenLimitPerDay: number | null;
  concurrencyLimit: number | null;
  compressToolResults: boolean;
  terseSystemPrompt: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  hash: string;
}
export interface GatewayStore {
  list(): GatewayKey[];
  put(key: GatewayKey): void;
  delete(id: string): void;
  recordRequest(keyId: string, at: string): void;
  recentRequests(keyId: string, now: string): number;
  recordUsage(keyId: string, inputTokens: number, outputTokens: number, at: string): void;
  tokenUsage(keyId: string, now: string): { minuteTokens: number; dayTokens: number };
  usage(keyId: string): {
    requests: number;
    successfulRequests: number;
    inputTokens: number;
    outputTokens: number;
  };
  touch(keyId: string, at: string): void;
}
export interface GatewayMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type?: string; function: { name: string; arguments: string } }[];
}
export interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: { type?: string };
  max_tokens?: number;
  temperature?: number;
}
export interface GatewayCompletion {
  id: string;
  model: string;
  text: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  reasoning?: string;
}

export {
  anthropicToCanonical,
  canonicalStreamEventsToAnthropic,
  canonicalStreamEventsToGemini,
  canonicalStreamEventsToOpenAiChat,
  canonicalStreamEventsToResponses,
  canonicalToAnthropicMessage,
  canonicalToGemini,
  canonicalToGatewayMessages,
  canonicalToOpenAiChat,
  canonicalToResponses,
  finalizeCanonicalStream,
  geminiToCanonical,
  openAiChatToCanonical,
  openAiResponsesToCanonical,
} from './canonical.js';
export type {
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalUsage,
  CanonicalToolCall,
} from './canonical.js';
export interface GatewayRuntime {
  store: GatewayStore;
  models(key: GatewayKey, profile?: string): string[] | Promise<string[]>;
  complete(input: {
    key: GatewayKey;
    model: string;
    messages: GatewayMessage[];
    instructions?: string;
    tools?: unknown[];
    toolChoice?: unknown;
    parallelToolCalls?: boolean;
    jsonMode?: boolean;
    maxTokens?: number;
    temperature?: number;
    sessionHint: string;
    signal: AbortSignal;
    onText?: (delta: string) => void;
    onToolCall?: (tool: { id: string; name: string; arguments: string }) => void;
  }): Promise<GatewayCompletion>;
}
export interface GatewayOptions {
  port?: number;
  allowLan?: boolean;
  allowLanConfirmed?: boolean;
  runtime: GatewayRuntime;
}
export interface GatewayHandle {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const aliases: Record<string, GatewayProfile> = {
  'ferry/auto-free': 'auto-free',
  'ferry/best': 'best',
  'ferry/fast': 'fast',
  'ferry/long-context': 'long-context',
};
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const secondsToUtcDayReset = (now: Date) =>
  Math.ceil(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) /
      1000,
  );

export function pruneRateState<K>(state: Map<K, number[]>, now: number): void {
  for (const [key, times] of state) {
    const recent = times.filter((at) => now - at < 60_000);
    if (recent.length) state.set(key, recent);
    else state.delete(key);
  }
}

export class GatewayRequestError extends Error {
  readonly code = 'invalid_request_error';
  constructor(message: string) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

export function createGatewayKey(
  input: Pick<GatewayKey, 'name' | 'profile'> & Partial<GatewayKey>,
  now = new Date(),
): { key: GatewayKey; secret: string } {
  const secret = `ferry-gw-${randomBytes(32).toString('base64url')}`;
  const key: GatewayKey = {
    id: randomBytes(12).toString('hex'),
    name: input.name.trim(),
    profile: input.profile,
    allowedModels: input.allowedModels ?? [],
    rateLimit: input.rateLimit ?? null,
    tokenLimitPerMinute: input.tokenLimitPerMinute ?? null,
    tokenLimitPerDay: input.tokenLimitPerDay ?? null,
    concurrencyLimit: input.concurrencyLimit ?? null,
    compressToolResults: input.compressToolResults ?? true,
    terseSystemPrompt: input.terseSystemPrompt ?? false,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    hash: hashToken(secret),
  };
  return { key, secret };
}

export function authenticateGatewayKey(token: string, keys: GatewayKey[]): GatewayKey | undefined {
  const candidate = Buffer.from(hashToken(token), 'hex');
  for (const key of keys) {
    const expected = Buffer.from(key.hash, 'hex');
    if (
      expected.length === candidate.length &&
      timingSafeEqual(candidate, expected) &&
      !key.revokedAt
    )
      return key;
  }
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
function errorBody(message: string, type = 'invalid_request_error', code: string | null = null) {
  return { error: { message, type, param: null, code } };
}
function anthropicError(message: string, type = 'invalid_request_error') {
  return { type: 'error', error: { type, message } };
}
function mappedFailure(error: unknown) {
  const errorName =
    error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  if (
    error instanceof GatewayRequestError ||
    /AI_InvalidPromptError|AI_TypeValidationError|AI_NoSuchToolError|ZodError|SchemaValidationError|ValidationError/.test(
      errorName,
    )
  ) {
    return {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request_error',
      message: error instanceof Error ? error.message : 'Invalid request',
    };
  }
  const outer = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const record =
    outer.name === 'AI_StreamProviderError' && outer.cause && typeof outer.cause === 'object'
      ? (outer.cause as Record<string, unknown>)
      : outer;
  const mapped = mapProviderError(error);
  const classified = classifyProviderError({
    status: record.status,
    statusCode: record.statusCode,
    code: record.code,
    type: record.type,
    message: record.message,
    responseBody: record.data ?? record.responseBody,
    ...(record.response instanceof Response ? { headers: record.response.headers } : {}),
  });
  const rawStatus = Number(classified.status ?? record.statusCode ?? record.status ?? 0);
  const status =
    rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : mapped.kind === 'auth'
        ? 401
        : mapped.kind === 'rate_limit' || mapped.kind === 'quota_exhausted'
          ? 429
          : mapped.kind === 'model_not_found'
            ? 404
            : mapped.kind === 'request_scoped_client' || mapped.kind === 'context_overflow'
              ? 400
              : 502;
  const type =
    status === 401
      ? 'authentication_error'
      : status === 429
        ? 'rate_limit_error'
        : status === 400
          ? 'invalid_request_error'
          : status >= 500
            ? 'server_error'
            : 'invalid_request_error';
  return {
    status,
    type,
    code: classified.family,
    message: mapped.message,
    retryable: classified.retryable,
  };
}
function textContent(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (!Array.isArray(value)) throw new GatewayRequestError(`${field} must contain text`);
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as Record<string, unknown>;
      if (typeof block.type === 'string' && /image|audio|video|file/.test(block.type))
        throw new GatewayRequestError('Image, audio, video, and file content is not supported yet');
      if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string')
        return block.text;
      if (block.type === 'tool_use' || block.type === 'tool_result') return '';
      if (block.type === 'refusal' && typeof block.refusal === 'string') return block.refusal;
      throw new GatewayRequestError(`Unsupported ${field} content block`);
    })
    .join('');
}
function normalizeMessages(raw: unknown[]): { messages: GatewayMessage[]; instructions: string } {
  const canonical = openAiChatToCanonical({ model: '', messages: raw });
  if (canonical.messages.length !== raw.length)
    throw new GatewayRequestError('Invalid message role or shape');
  return canonicalToGatewayMessages(canonical.messages);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 8 * 1024 * 1024) throw new Error('Request body exceeds 8 MiB');
    chunks.push(new Uint8Array(data));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  const key = req.headers['x-api-key'];
  return match?.[1] ?? (typeof key === 'string' ? key : undefined);
}
function anthropicMessages(raw: unknown[]): GatewayMessage[] {
  const converted = anthropicToCanonical({ model: '', messages: raw }).messages;
  return canonicalToGatewayMessages(converted).messages;
}
function anthropicTools(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    return typeof item.name === 'string'
      ? [
          {
            type: 'function',
            function: {
              name: item.name,
              description: item.description,
              parameters: item.input_schema,
            },
          },
        ]
      : [];
  });
}
function modelFor(raw: string, key: GatewayKey): string {
  const alias = aliases[raw];
  const model = raw.startsWith('ferry/') ? (alias ? `@profile:${alias}` : '') : raw;
  if (!model || (key.allowedModels.length > 0 && !key.allowedModels.includes(raw)))
    throw new Error('Unknown model');
  return alias ? `@profile:${alias}` : model;
}
function chatChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayRuntime,
  key: GatewayKey,
  reserve: (key: GatewayKey, tokens: number) => { retryAfter: number | null; release(): void },
): Promise<void> {
  let input: GatewayRequest;
  try {
    input = (await body(req)) as unknown as GatewayRequest;
  } catch (error) {
    json(res, 400, errorBody(error instanceof Error ? error.message : 'Invalid JSON'));
    return;
  }
  if (typeof input.model !== 'string' || !Array.isArray(input.messages)) {
    json(res, 400, errorBody('model and messages are required'));
    return;
  }
  let model: string;
  try {
    model = modelFor(input.model, key);
  } catch {
    json(res, 404, errorBody(`Unknown model: ${input.model}`, 'model_not_found'));
    return;
  }
  const requestedProfile = aliases[input.model];
  if (
    (requestedProfile && (await runtime.models(key, requestedProfile)).length === 0) ||
    (!requestedProfile &&
      !model.startsWith('@profile:') &&
      !(await runtime.models(key)).includes(model))
  ) {
    json(res, 404, errorBody(`Unknown model: ${input.model}`, 'model_not_found'));
    return;
  }
  const reserved = reserve(
    key,
    Math.ceil(JSON.stringify(input).length / 4) + Math.max(0, input.max_tokens ?? 0),
  );
  if (reserved.retryAfter !== null) {
    res.setHeader('retry-after', String(reserved.retryAfter));
    json(res, 429, errorBody('Ferry gateway key token budget exceeded', 'rate_limit_error'));
    return;
  }
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
  const sessionHint = String(
    req.headers['x-ferry-session'] ??
      req.headers['x-session-id'] ??
      createHash('sha256')
        .update(JSON.stringify(input.messages[0] ?? {}))
        .digest('hex'),
  );
  const usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const normalized = normalizeMessages(input.messages);
    if (input.stream) {
      let streamStarted = false;
      const beginStream = () => {
        if (streamStarted) return;
        streamStarted = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(chatChunk(id, input.model, { role: 'assistant' }))}\n\n`);
      };
      let tools: GatewayCompletion['toolCalls'] = [];
      const result = await runtime.complete({
        key,
        model,
        messages: normalized.messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.tool_choice !== undefined ? { toolChoice: input.tool_choice } : {}),
        ...(input.parallel_tool_calls !== undefined
          ? { parallelToolCalls: input.parallel_tool_calls }
          : {}),
        jsonMode: input.response_format?.type === 'json_object',
        ...(input.max_tokens ? { maxTokens: input.max_tokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        sessionHint,
        signal: controller.signal,
        onText: (delta) => {
          beginStream();
          res.write(`data: ${JSON.stringify(chatChunk(id, input.model, { content: delta }))}\n\n`);
        },
        onToolCall: (tool) => {
          beginStream();
          tools = [...(tools ?? []), tool];
        },
      });
      reserved.release();
      beginStream();
      usage.inputTokens = result.inputTokens;
      usage.outputTokens = result.outputTokens;
      if (tools.length)
        res.write(
          `data: ${JSON.stringify(chatChunk(id, input.model, { tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) }))}\n\n`,
        );
      const finishReason = tools.length ? 'tool_calls' : result.finishReason;
      res.write(
        `data: ${JSON.stringify({ ...chatChunk(id, input.model, {}, finishReason), choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    } else {
      const result = await runtime.complete({
        key,
        model,
        messages: normalized.messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.tool_choice !== undefined ? { toolChoice: input.tool_choice } : {}),
        ...(input.parallel_tool_calls !== undefined
          ? { parallelToolCalls: input.parallel_tool_calls }
          : {}),
        jsonMode: input.response_format?.type === 'json_object',
        ...(input.max_tokens ? { maxTokens: input.max_tokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        sessionHint,
        signal: controller.signal,
      });
      reserved.release();
      usage.inputTokens = result.inputTokens;
      usage.outputTokens = result.outputTokens;
      json(res, 200, {
        id: result.id || id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text || null,
              ...(result.toolCalls?.length
                ? {
                    tool_calls: result.toolCalls.map((tool) => ({
                      id: tool.id,
                      type: 'function',
                      function: { name: tool.name, arguments: tool.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: result.toolCalls?.length ? 'tool_calls' : result.finishReason,
          },
        ],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
      });
    }
    runtime.store.recordUsage(
      key.id,
      usage.inputTokens,
      usage.outputTokens,
      new Date().toISOString(),
    );
  } catch (error) {
    reserved.release();
    const mapped = mappedFailure(error);
    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: { message: mapped.message, type: mapped.type, code: mapped.code } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    } else json(res, mapped.status, errorBody(mapped.message, mapped.type, mapped.code));
  }
}

async function handleAnthropic(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayRuntime,
  key: GatewayKey,
  reserve: (key: GatewayKey, tokens: number) => { retryAfter: number | null; release(): void },
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await body(req);
  } catch (error) {
    json(res, 400, errorBody(error instanceof Error ? error.message : 'Invalid JSON'));
    return;
  }
  if (typeof payload.model !== 'string' || !Array.isArray(payload.messages)) {
    json(res, 400, anthropicError('model and messages are required'));
    return;
  }
  const originalModel = payload.model;
  let model: string;
  try {
    model = modelFor(originalModel, key);
  } catch {
    json(res, 404, anthropicError(`Unknown model: ${originalModel}`, 'not_found_error'));
    return;
  }
  const requestedProfile = aliases[originalModel];
  if (
    (requestedProfile && (await runtime.models(key, requestedProfile)).length === 0) ||
    (!requestedProfile &&
      !model.startsWith('@profile:') &&
      !(await runtime.models(key)).includes(model))
  ) {
    json(res, 404, anthropicError(`Unknown model: ${originalModel}`, 'not_found_error'));
    return;
  }
  const reserved = reserve(
    key,
    Math.ceil(JSON.stringify(payload).length / 4) + Math.max(0, Number(payload.max_tokens) || 0),
  );
  if (reserved.retryAfter !== null) {
    res.setHeader('retry-after', String(reserved.retryAfter));
    json(res, 429, anthropicError('Ferry gateway key token budget exceeded', 'rate_limit_error'));
    return;
  }
  const tools = anthropicTools(payload.tools);
  const rawChoice =
    payload.tool_choice && typeof payload.tool_choice === 'object'
      ? (payload.tool_choice as Record<string, unknown>)
      : undefined;
  const toolChoice =
    rawChoice?.type === 'tool' && typeof rawChoice.name === 'string'
      ? { function: { name: rawChoice.name } }
      : rawChoice?.type === 'any'
        ? 'required'
        : rawChoice?.type === 'none'
          ? 'none'
          : rawChoice?.type === 'auto'
            ? 'auto'
            : undefined;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const id = `msg_${randomBytes(12).toString('hex')}`;
  const sessionHint = String(
    req.headers['x-ferry-session'] ??
      req.headers['x-session-id'] ??
      createHash('sha256')
        .update(JSON.stringify(payload.messages[0] ?? {}))
        .digest('hex'),
  );
  try {
    const topLevelSystem = textContent(payload.system, 'system prompt');
    const normalized = normalizeMessages([
      ...(topLevelSystem ? [{ role: 'system', content: topLevelSystem }] : []),
      ...anthropicMessages(payload.messages),
    ]);
    const messages = normalized.messages;
    if (payload.stream === true) {
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let streamStarted = false;
      const textStarted = { value: false };
      const beginStream = () => {
        if (streamStarted) return;
        streamStarted = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        send('message_start', {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model: originalModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      };
      const toolCalls: GatewayCompletion['toolCalls'] = [];
      const result = await runtime.complete({
        key,
        model,
        messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...(payload.max_tokens ? { maxTokens: Number(payload.max_tokens) } : {}),
        sessionHint,
        signal: controller.signal,
        onText: (delta) => {
          beginStream();
          if (!textStarted.value) {
            textStarted.value = true;
            send('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
          }
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta },
          });
        },
        onToolCall: (call) => {
          beginStream();
          toolCalls.push(call);
        },
      });
      reserved.release();
      beginStream();
      if (textStarted.value) send('content_block_stop', { type: 'content_block_stop', index: 0 });
      for (let i = 0; i < (result.toolCalls?.length ?? 0); i++) {
        const call = result.toolCalls?.[i];
        if (!call) continue;
        send('content_block_start', {
          type: 'content_block_start',
          index: (textStarted.value ? 1 : 0) + i,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: (textStarted.value ? 1 : 0) + i,
          delta: { type: 'input_json_delta', partial_json: call.arguments },
        });
        send('content_block_stop', {
          type: 'content_block_stop',
          index: (textStarted.value ? 1 : 0) + i,
        });
      }
      send('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
      });
      send('message_stop', { type: 'message_stop' });
      res.end();
      runtime.store.recordUsage(
        key.id,
        result.inputTokens,
        result.outputTokens,
        new Date().toISOString(),
      );
    } else {
      const result = await runtime.complete({
        key,
        model,
        messages,
        ...(normalized.instructions ? { instructions: normalized.instructions } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...(payload.max_tokens ? { maxTokens: Number(payload.max_tokens) } : {}),
        sessionHint,
        signal: controller.signal,
      });
      reserved.release();
      runtime.store.recordUsage(
        key.id,
        result.inputTokens,
        result.outputTokens,
        new Date().toISOString(),
      );
      json(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model: originalModel,
        content: [
          ...(result.text ? [{ type: 'text', text: result.text }] : []),
          ...(result.toolCalls ?? []).map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: JSON.parse(call.arguments) as unknown,
          })),
        ],
        stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
      });
    }
  } catch (error) {
    reserved.release();
    const mapped = mappedFailure(error);
    if (res.headersSent) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: mapped.type, message: mapped.message } })}\n\n`,
      );
      res.end();
    } else json(res, mapped.status, anthropicError(mapped.message, mapped.type));
  }
}

type Protocol = 'responses' | 'gemini';

function protocolError(
  res: ServerResponse,
  protocol: Protocol,
  status: number,
  message: string,
): void {
  json(
    res,
    status,
    protocol === 'responses'
      ? errorBody(message)
      : {
          error: { code: status, status: status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT', message },
        },
  );
}

async function handleCanonicalProtocol(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayRuntime,
  key: GatewayKey,
  protocol: Protocol,
  routeModel?: string,
  forceStream = false,
  reserve?: (key: GatewayKey, tokens: number) => { retryAfter: number | null; release(): void },
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await body(req);
  } catch (error) {
    protocolError(res, protocol, 400, error instanceof Error ? error.message : 'Invalid JSON');
    return;
  }

  let canonical;
  try {
    canonical =
      protocol === 'responses'
        ? openAiResponsesToCanonical(payload)
        : geminiToCanonical(payload, routeModel ?? '');
  } catch (error) {
    protocolError(res, protocol, 400, error instanceof Error ? error.message : 'Invalid request');
    return;
  }
  const originalModel =
    protocol === 'responses' ? canonical.model : (routeModel ?? canonical.model);
  let model: string;
  try {
    model = modelFor(originalModel, key);
  } catch {
    protocolError(res, protocol, 404, `Unknown model: ${originalModel}`);
    return;
  }
  const requestedProfile = aliases[originalModel];
  if (
    (requestedProfile && (await runtime.models(key, requestedProfile)).length === 0) ||
    (!requestedProfile &&
      !model.startsWith('@profile:') &&
      !(await runtime.models(key)).includes(model))
  ) {
    protocolError(res, protocol, 404, `Unknown model: ${originalModel}`);
    return;
  }
  const estimate =
    Math.ceil(JSON.stringify(payload).length / 4) + Math.max(0, canonical.maxTokens ?? 0);
  const reservation = reserve?.(key, estimate);
  if (reservation?.retryAfter !== null && reservation) {
    res.setHeader('retry-after', String(reservation.retryAfter));
    protocolError(res, protocol, 429, 'Ferry gateway key token budget exceeded');
    return;
  }
  const converted = canonicalToGatewayMessages(canonical.messages);
  const tools = canonical.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const responseId = protocol === 'responses' ? `resp_${randomBytes(12).toString('hex')}` : '';
  const stream = forceStream || canonical.stream;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const sessionHint = String(
    req.headers['x-ferry-session'] ??
      req.headers['x-session-id'] ??
      createHash('sha256')
        .update(JSON.stringify(payload.input ?? payload.contents ?? {}))
        .digest('hex'),
  );
  const deltas: { type: 'text_delta'; text: string }[] = [];
  const calls: NonNullable<GatewayCompletion['toolCalls']> = [];
  const streamedCallIds = new Set<string>();
  const responseSend = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let responseMessageStarted = false;
  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (protocol === 'responses') {
      const started = {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        model: originalModel,
        output: [],
        output_text: '',
      };
      responseSend('response.created', { type: 'response.created', response: started });
      responseSend('response.in_progress', { type: 'response.in_progress', response: started });
    }
  }
  try {
    const result = await runtime.complete({
      key,
      model,
      messages: converted.messages,
      ...(converted.instructions ? { instructions: converted.instructions } : {}),
      ...(tools ? { tools } : {}),
      ...(canonical.toolChoice !== undefined ? { toolChoice: canonical.toolChoice } : {}),
      ...(canonical.maxTokens ? { maxTokens: canonical.maxTokens } : {}),
      ...(canonical.temperature !== undefined ? { temperature: canonical.temperature } : {}),
      sessionHint,
      signal: controller.signal,
      ...(stream
        ? {
            onText: (text: string) => {
              deltas.push({ type: 'text_delta', text });
              if (protocol === 'responses') {
                if (!responseMessageStarted) {
                  responseMessageStarted = true;
                  responseSend('response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: {
                      type: 'message',
                      id: `${responseId}_message`,
                      role: 'assistant',
                      status: 'in_progress',
                      content: [],
                    },
                  });
                  responseSend('response.content_part.added', {
                    type: 'response.content_part.added',
                    item_id: `${responseId}_message`,
                    output_index: 0,
                    content_index: 0,
                    part: { type: 'output_text', text: '', annotations: [] },
                  });
                }
                responseSend('response.output_text.delta', {
                  type: 'response.output_text.delta',
                  item_id: `${responseId}_message`,
                  output_index: 0,
                  content_index: 0,
                  delta: text,
                });
              } else {
                res.write(
                  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\n\n`,
                );
              }
            },
            onToolCall: (call: NonNullable<GatewayCompletion['toolCalls']>[number]) => {
              calls.push(call);
              streamedCallIds.add(call.id);
              if (protocol === 'responses') {
                const outputIndex = (responseMessageStarted ? 1 : 0) + calls.length - 1;
                responseSend('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: outputIndex,
                  item: {
                    type: 'function_call',
                    id: call.id,
                    call_id: call.id,
                    name: call.name,
                    arguments: '',
                    status: 'in_progress',
                  },
                });
                responseSend('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  item_id: call.id,
                  output_index: outputIndex,
                  delta: call.arguments,
                });
              } else {
                res.write(
                  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: call.id, name: call.name, args: parseArguments(call.arguments) } }] }, index: 0 }] })}\n\n`,
                );
              }
            },
          }
        : {}),
    });
    reservation?.release();
    runtime.store.recordUsage(
      key.id,
      result.inputTokens,
      result.outputTokens,
      new Date().toISOString(),
    );
    const allCalls = result.toolCalls?.length ? result.toolCalls : calls;
    if (protocol === 'responses') {
      const output = [
        ...(result.reasoning
          ? [
              {
                type: 'reasoning',
                id: `${responseId}_reasoning`,
                summary: [{ type: 'summary_text', text: result.reasoning }],
              },
            ]
          : []),
        ...(result.text
          ? [
              {
                type: 'message',
                id: `${responseId}_message`,
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: result.text, annotations: [] }],
              },
            ]
          : []),
        ...allCalls.map((call) => ({
          type: 'function_call',
          id: call.id,
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'completed',
        })),
      ];
      const responseBody = {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        error: null,
        incomplete_details: null,
        model: originalModel,
        output,
        output_text: result.text,
        parallel_tool_calls: true,
        usage: {
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          total_tokens: result.inputTokens + result.outputTokens,
        },
      };
      if (!stream) {
        json(res, 200, responseBody);
        return;
      }
      if (!deltas.length && result.text) {
        responseMessageStarted = true;
        responseSend('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: `${responseId}_message`,
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        });
        responseSend('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: `${responseId}_message`,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        responseSend('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: `${responseId}_message`,
          output_index: 0,
          content_index: 0,
          delta: result.text,
        });
      }
      allCalls.forEach((call, index) => {
        if (streamedCallIds.has(call.id)) return;
        const outputIndex = (responseMessageStarted ? 1 : 0) + index;
        responseSend('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            type: 'function_call',
            id: call.id,
            call_id: call.id,
            name: call.name,
            arguments: '',
            status: 'in_progress',
          },
        });
        responseSend('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: call.id,
          output_index: outputIndex,
          delta: call.arguments,
        });
      });
      const messageOutputIndex = result.reasoning ? 1 : 0;
      if (result.text) {
        responseSend('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: `${responseId}_message`,
          output_index: messageOutputIndex,
          content_index: 0,
          text: result.text,
        });
        responseSend('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: `${responseId}_message`,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: result.text, annotations: [] },
        });
        responseSend('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: messageOutputIndex,
          item: output[messageOutputIndex],
        });
      }
      allCalls.forEach((call, index) => {
        const outputIndex = (result.reasoning ? 1 : 0) + (result.text ? 1 : 0) + index;
        responseSend('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: call.id,
          output_index: outputIndex,
          arguments: call.arguments,
        });
        responseSend('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item: output[outputIndex],
        });
      });
      if (result.reasoning)
        responseSend('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: `${responseId}_reasoning`,
          output_index: 0,
          summary_index: 0,
          delta: result.reasoning,
        });
      const final = finalizeCanonicalStream([], result.finishReason, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      responseSend('response.completed', {
        type: 'response.completed',
        response: { ...responseBody, status: 'completed', finish_reason: final.finishReason },
      });
      res.end();
      return;
    }
    const candidate = {
      content: {
        role: 'model',
        parts: [
          ...(result.text ? [{ text: result.text }] : []),
          ...allCalls.map((call) => ({
            functionCall: { id: call.id, name: call.name, args: parseArguments(call.arguments) },
          })),
        ],
      },
      finishReason: allCalls.length ? 'STOP' : 'STOP',
      index: 0,
    };
    const usageMetadata = {
      promptTokenCount: result.inputTokens,
      candidatesTokenCount: result.outputTokens,
      totalTokenCount: result.inputTokens + result.outputTokens,
    };
    if (!stream) {
      json(res, 200, { candidates: [candidate], usageMetadata, modelVersion: originalModel });
      return;
    }
    if (!deltas.length && result.text)
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: result.text }] }, index: 0 }] })}\n\n`,
      );
    const final = finalizeCanonicalStream(deltas, result.finishReason, {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    res.write(
      `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP', index: 0 }], usageMetadata, modelVersion: originalModel, finishReason: final.finishReason })}\n\n`,
    );
    res.end();
  } catch (error) {
    reservation?.release();
    const mapped = mappedFailure(error);
    if (res.headersSent) {
      if (protocol === 'responses')
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: mapped.message, type: mapped.type, code: mapped.code } })}\n\n`,
        );
      else
        res.write(
          `data: ${JSON.stringify({ error: { code: mapped.status, status: mapped.type, message: mapped.message } })}\n\n`,
        );
      res.end();
    } else protocolError(res, protocol, mapped.status, mapped.message);
  }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  if (options.allowLan && !options.allowLanConfirmed)
    throw new Error('LAN gateway binding requires explicit confirmation');
  const host = options.allowLan ? '0.0.0.0' : '127.0.0.1';
  const activeRequests = new Map<string, number>();
  const reservedTokens = new Map<string, { minute: number; day: number }>();
  const reserveTokens = (key: GatewayKey, tokens: number) => {
    const now = new Date();
    const persisted = options.runtime.store.tokenUsage(key.id, now.toISOString());
    const reserved = reservedTokens.get(key.id) ?? { minute: 0, day: 0 };
    const perMinute = persisted.minuteTokens + reserved.minute;
    const perDay = persisted.dayTokens + reserved.day;
    const exceededMinute =
      key.tokenLimitPerMinute !== null && perMinute + tokens > key.tokenLimitPerMinute;
    const exceededDay = key.tokenLimitPerDay !== null && perDay + tokens > key.tokenLimitPerDay;
    if (exceededMinute || exceededDay) {
      return {
        retryAfter: exceededMinute ? 60 : secondsToUtcDayReset(now),
        release: () => undefined,
      };
    }
    reservedTokens.set(key.id, { minute: reserved.minute + tokens, day: reserved.day + tokens });
    let released = false;
    return {
      retryAfter: null,
      release: () => {
        if (released) return;
        released = true;
        const current = reservedTokens.get(key.id);
        if (!current) return;
        const next = {
          minute: Math.max(0, current.minute - tokens),
          day: Math.max(0, current.day - tokens),
        };
        if (next.minute === 0 && next.day === 0) reservedTokens.delete(key.id);
        else reservedTokens.set(key.id, next);
      },
    };
  };
  const failedAuth = new Map<string, number[]>();
  const rejectBrowserOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!req.headers.origin) return false;
    json(res, 403, errorBody('Browser origins are not allowed by the Ferry gateway', 'forbidden'));
    return true;
  };
  const badAuthentication = (req: IncomingMessage, res: ServerResponse, protocol?: Protocol) => {
    const address = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const recent = (failedAuth.get(address) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 5) {
      res.setHeader('retry-after', '60');
      if (protocol)
        protocolError(res, protocol, 429, 'Too many failed gateway authentication attempts');
      else
        json(
          res,
          429,
          errorBody('Too many failed gateway authentication attempts', 'rate_limit_error'),
        );
      return;
    }
    recent.push(now);
    failedAuth.set(address, recent);
    if (protocol) protocolError(res, protocol, 401, 'Invalid or revoked Ferry gateway key');
    else json(res, 401, errorBody('Invalid or revoked Ferry gateway key', 'authentication_error'));
  };
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const now = Date.now();
    pruneRateState(failedAuth, now);
    if (rejectBrowserOrigin(req, res)) return;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, service: 'ferry-gateway' });
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      const token = bearer(req);
      const key = token ? authenticateGatewayKey(token, options.runtime.store.list()) : undefined;
      if (!key) {
        badAuthentication(req, res);
        return;
      }
      failedAuth.delete(req.socket.remoteAddress ?? 'unknown');
      options.runtime.store.touch(key.id, new Date().toISOString());
      const availableModels = await options.runtime.models(key);
      const ids = [
        ...(
          await Promise.all(
            Object.entries(aliases).map(async ([alias, profile]) =>
              (key.allowedModels.length === 0 || key.allowedModels.includes(alias)) &&
              (await options.runtime.models(key, profile)).length > 0
                ? alias
                : null,
            ),
          )
        ).filter((id): id is string => id !== null),
        ...availableModels.filter(
          (id) => key.allowedModels.length === 0 || key.allowedModels.includes(id),
        ),
      ];
      json(res, 200, {
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'ferry' })),
      });
      return;
    }
    const geminiRoute = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(
      path,
    );
    const protocol: Protocol | undefined =
      path === '/v1/responses' ? 'responses' : geminiRoute ? 'gemini' : undefined;
    if (
      req.method === 'POST' &&
      (path === '/v1/chat/completions' || path === '/v1/messages' || protocol !== undefined)
    ) {
      const token = bearer(req);
      const key = token ? authenticateGatewayKey(token, options.runtime.store.list()) : undefined;
      if (!key) {
        badAuthentication(req, res, protocol);
        return;
      }
      failedAuth.delete(req.socket.remoteAddress ?? 'unknown');
      if (key.rateLimit !== null) {
        if (
          options.runtime.store.recentRequests(key.id, new Date().toISOString()) >= key.rateLimit
        ) {
          res.setHeader('retry-after', '60');
          json(
            res,
            429,
            path === '/v1/messages'
              ? anthropicError('Ferry gateway key rate limit exceeded', 'rate_limit_error')
              : protocol === 'responses'
                ? errorBody('Ferry gateway key rate limit exceeded', 'rate_limit_error')
                : protocol === 'gemini'
                  ? {
                      error: {
                        code: 429,
                        status: 'RESOURCE_EXHAUSTED',
                        message: 'Ferry gateway key rate limit exceeded',
                      },
                    }
                  : errorBody('Ferry gateway key rate limit exceeded', 'rate_limit_error'),
          );
          return;
        }
      }
      if (
        key.concurrencyLimit !== null &&
        (activeRequests.get(key.id) ?? 0) >= key.concurrencyLimit
      ) {
        res.setHeader('retry-after', '1');
        json(
          res,
          429,
          path === '/v1/messages'
            ? anthropicError('Ferry gateway key concurrency limit exceeded', 'rate_limit_error')
            : protocol === 'gemini'
              ? {
                  error: {
                    code: 429,
                    status: 'RESOURCE_EXHAUSTED',
                    message: 'Ferry gateway key concurrency limit exceeded',
                  },
                }
              : errorBody('Ferry gateway key concurrency limit exceeded', 'rate_limit_error'),
        );
        return;
      }
      const requestAt = new Date().toISOString();
      options.runtime.store.recordRequest(key.id, requestAt);
      activeRequests.set(key.id, (activeRequests.get(key.id) ?? 0) + 1);
      options.runtime.store.touch(key.id, new Date().toISOString());
      try {
        if (protocol)
          await handleCanonicalProtocol(
            req,
            res,
            options.runtime,
            key,
            protocol,
            protocol === 'gemini' ? decodeURIComponent(geminiRoute?.[1] ?? '') : undefined,
            geminiRoute?.[2] === 'streamGenerateContent' ||
              new URL(req.url ?? '/', 'http://localhost').searchParams.get('alt') === 'sse',
            reserveTokens,
          );
        else if (path === '/v1/messages')
          await handleAnthropic(req, res, options.runtime, key, reserveTokens);
        else await handleChat(req, res, options.runtime, key, reserveTokens);
      } finally {
        const active = activeRequests.get(key.id) ?? 1;
        if (active <= 1) activeRequests.delete(key.id);
        else activeRequests.set(key.id, active - 1);
      }
      return;
    }
    json(res, 404, errorBody('Not found', 'not_found'));
  };
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  const wantedPort = options.port ?? 11435;
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListen);
      if (error.code === 'EADDRINUSE' && wantedPort !== 0) {
        server.removeListener('error', onError);
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(0, host);
        return;
      }
      reject(error);
    };
    const onListen = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Gateway failed to bind'));
      else resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(wantedPort, host);
  });
  return {
    port,
    host,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
